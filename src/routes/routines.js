const router = require("express").Router();
const { auth } = require("../middleware/auth");
const {
  createRoutineSchema,
  updateRoutineSchema,
  addExerciseSchema,
} = require("../schemas/routine.schema");
const asyncRoute = require("../utils/asyncRoute");

const prisma = require("../lib/prisma");
const { rangeTodayKST } = require("../utils/time");

/**
 * 어제 이전에 활성화된 루틴들을 자동으로 비활성화
 */
async function deactivateOldRoutines(userId, tx = prisma) {
  const { start } = rangeTodayKST(); // 오늘 00:00 KST

  const deactivated = await tx.workoutRoutine.updateMany({
    where: {
      userId,
      isActive: true,
      updatedAt: { lt: start }, // 오늘 이전에 업데이트된 것들
    },
    data: {
      isActive: false,
    },
  });

  if (deactivated.count > 0) {
    console.log(
      `User ${userId}: ${deactivated.count}개의 오래된 루틴 자동 비활성화`,
    );
  }

  return deactivated.count;
}

/**
 * order 재정렬 헬퍼 함수
 * order 값이 중복되거나 빈 공간이 있을 때 1, 2, 3... 순서로 재정렬
 */
// ✅ 개선된 reorderExercises: 현재 order를 기준으로 재정렬
/**
 * order 재정렬 헬퍼 함수
 * order 값이 중복되거나 빈 공간이 있을 때 1, 2, 3... 순서로 재정렬
 */
async function reorderExercises(tx, routineId, preferredMoves = []) {
  const rows = await tx.routineExercise.findMany({
    where: { routineId },
    select: { id: true, order: true },
    orderBy: { order: "asc" },
  });
  if (rows.length === 0) return;

  // 현재 순서 배열 (id만)
  const ordered = rows.map((r) => r.id);
  const N = ordered.length;
  const clamp = (n) => Math.max(1, Math.min(n, N));

  // 같은 id에 대한 중복 move는 "마지막 지시만" 남기되,
  // 적용은 preferredMoves가 들어온 원래 순서를 최대한 존중
  const seen = new Set();
  const deduped = [];
  for (let i = preferredMoves.length - 1; i >= 0; i--) {
    const mv = preferredMoves[i];
    if (!mv || typeof mv.id !== "number" || typeof mv.order !== "number")
      continue;
    if (seen.has(mv.id)) continue;
    seen.add(mv.id);
    deduped.unshift({ id: mv.id, order: mv.order });
  }

  // 컷-인서트 적용
  for (const { id, order } of deduped) {
    const fromIdx = ordered.indexOf(id);
    if (fromIdx === -1) continue;
    ordered.splice(fromIdx, 1); // 잘라내기
    const insertIdx = Math.min(clamp(order) - 1, ordered.length);
    ordered.splice(insertIdx, 0, id); // 끼워 넣기
  }

  // 충돌 회피용 +1000 후 1..N 재부여
  await tx.routineExercise.updateMany({
    where: { routineId },
    data: { order: { increment: 1000 } },
  });
  for (let i = 0; i < ordered.length; i++) {
    await tx.routineExercise.update({
      where: { id: ordered[i] },
      data: { order: i + 1 },
    });
  }
}

//조회 API : GET
// GET /api/routines
router.get(
  "/",
  auth(),
  asyncRoute(async (req, res) => {
    const { isActive } = req.query;
    await deactivateOldRoutines(req.user.id);
    const where = {
      userId: req.user.id,
      ...(isActive !== undefined && {
        isActive: isActive === "true",
      }),
    };

    const routines = await prisma.workoutRoutine.findMany({
      where,
      include: {
        exercises: {
          include: {
            equipment: {
              select: {
                id: true,
                name: true,
                category: true,
                muscleGroup: true,
                imageUrl: true,
              },
            },
          },
          orderBy: { order: "asc" },
        },
        _count: { select: { exercises: true } },
      },
      orderBy: [{ isActive: "desc" }, { updatedAt: "desc" }],
    });

    res.json(
      routines.map((r) => {
        // 🆕 예상 소요시간 계산
        const estimatedMinutes = r.exercises.reduce((total, ex) => {
          const setTime = ex.targetSets * 3; // 세트당 3분 (평균)
          const restTime = Math.floor(
            ((ex.targetSets - 1) * ex.restSeconds) / 60,
          ); // 휴식시간 (초→분)
          return total + setTime + restTime;
        }, 0);

        return {
          id: r.id,
          name: r.name,
          isActive: r.isActive,
          exerciseCount: r._count.exercises,
          estimatedMinutes: estimatedMinutes, // 🆕 예상 시간 (분)
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          exercises: r.exercises.map((ex) => ({
            id: ex.id,
            order: ex.order,
            targetSets: ex.targetSets,
            targetReps: ex.targetReps,
            restSeconds: ex.restSeconds,
            notes: ex.notes,
            equipment: ex.equipment,
          })),
        };
      }),
    );
  }),
);

// GET /api/routines/:id
router.get(
  "/:id",
  auth(),
  asyncRoute(async (req, res) => {
    const routineId = parseInt(req.params.id, 10);
    await deactivateOldRoutines(req.user.id);
    const routine = await prisma.workoutRoutine.findFirst({
      where: { id: routineId, userId: req.user.id },
      include: {
        exercises: { include: { equipment: true }, orderBy: { order: "asc" } },
      },
    });
    if (!routine)
      return res.status(404).json({ error: "루틴을 찾을 수 없습니다" });

    const equipmentIds = routine.exercises.map((e) => e.equipmentId);
    const [currentUsages, waitingQueues, myCurrentUsage, myWaitingQueues] =
      await Promise.all([
        prisma.equipmentUsage.findMany({
          where: { equipmentId: { in: equipmentIds }, status: "IN_USE" },
          include: { user: { select: { name: true } } },
        }),
        prisma.waitingQueue.findMany({
          where: {
            equipmentId: { in: equipmentIds },
            status: { in: ["WAITING", "NOTIFIED"] },
          },
          orderBy: { queuePosition: "asc" },
        }),
        prisma.equipmentUsage.findFirst({
          where: { userId: req.user.id, status: "IN_USE" },
          include: { equipment: true },
        }),
        prisma.waitingQueue.findMany({
          where: {
            userId: req.user.id,
            status: { in: ["WAITING", "NOTIFIED"] },
            equipmentId: { in: equipmentIds },
          },
        }),
      ]);

    const exercises = routine.exercises.map((ex) => {
      const cu = currentUsages.find((u) => u.equipmentId === ex.equipmentId);
      const queueCount = waitingQueues.filter(
        (q) => q.equipmentId === ex.equipmentId,
      ).length;
      const myQ = myWaitingQueues.find((q) => q.equipmentId === ex.equipmentId);
      return {
        id: ex.id,
        order: ex.order,
        targetSets: ex.targetSets,
        targetReps: ex.targetReps,
        restSeconds: ex.restSeconds, // 이미 초 단위
        notes: ex.notes,
        equipment: ex.equipment,
        status: {
          isAvailable: !cu,
          currentUser: cu ? cu.user.name : null,
          currentUserId: cu ? cu.user.id : null,
          currentUserStartedAt: cu ? cu.startedAt : null,
          waitingCount: queueCount,
          myQueuePosition: myQ ? myQ.queuePosition : null,
          myQueueStatus: myQ ? myQ.status : null,
          canStart:
            !cu &&
            !myQ &&
            (!myCurrentUsage || myCurrentUsage.equipmentId === ex.equipmentId),
          canQueue:
            cu &&
            !myQ &&
            (!myCurrentUsage || myCurrentUsage.equipmentId === ex.equipmentId),
        },
      };
    });

    res.json({
      id: routine.id,
      name: routine.name,
      isActive: routine.isActive,
      createdAt: routine.createdAt,
      updatedAt: routine.updatedAt,
      exercises,
      currentlyUsing: myCurrentUsage
        ? {
            equipmentId: myCurrentUsage.equipmentId,
            equipmentName: myCurrentUsage.equipment.name,
          }
        : null,
    });
  }),
);

//생성API : POST
// POST /api/routines
router.post(
  "/",
  auth(),
  asyncRoute(async (req, res) => {
    const v = createRoutineSchema.safeParse(req.body);
    if (!v.success)
      return res.status(400).json({
        error: "입력 데이터가 올바르지 않습니다",
        details: v.error.issues,
      });

    const { name, exercises } = v.data;
    const equipmentIds = exercises.map((e) => e.equipmentId);
    const exists = await prisma.equipment.count({
      where: { id: { in: equipmentIds } },
    });
    if (exists !== equipmentIds.length)
      return res
        .status(400)
        .json({ error: "존재하지 않는 기구가 포함되어 있습니다" });

    const routine = await prisma.$transaction(async (tx) => {
      const created = await tx.workoutRoutine.create({
        data: { userId: req.user.id, name },
      });
      await tx.routineExercise.createMany({
        data: exercises.map((e, i) => ({
          routineId: created.id,
          equipmentId: e.equipmentId,
          order: i + 1,
          targetSets: e.targetSets,
          targetReps: e.targetReps,
          restSeconds: e.restSeconds, // 이미 초 단위
          notes: e.notes,
        })),
      });
      return tx.workoutRoutine.findUnique({
        where: { id: created.id },
        include: {
          exercises: {
            include: { equipment: true },
            orderBy: { order: "asc" },
          },
        },
      });
    });

    res.status(201).json({
      id: routine.id,
      name: routine.name,
      isActive: routine.isActive,
      exerciseCount: routine.exercises.length,
      exercises: routine.exercises,
      createdAt: routine.createdAt,
      updatedAt: routine.updatedAt,
    });
  }),
);

// 수정된 PATCH /api/routines/:id
router.patch(
  "/:id",
  auth(),
  asyncRoute(async (req, res) => {
    const routineId = parseInt(req.params.id, 10);
    const { name, isActive, exercises } = req.body;

    // 루틴 소유권 + 현재 운동 조회
    const routine = await prisma.workoutRoutine.findFirst({
      where: { id: routineId, userId: req.user.id },
      include: {
        exercises: {
          include: { equipment: true },
          orderBy: { order: "asc" },
        },
      },
    });
    if (!routine)
      return res.status(404).json({ error: "루틴을 찾을 수 없습니다" });

    const updated = await prisma.$transaction(async (tx) => {
      // 1) 루틴 기본 정보 수정
      if (name !== undefined || isActive !== undefined) {
        await tx.workoutRoutine.update({
          where: { id: routineId },
          data: {
            ...(name !== undefined && { name }),
            ...(isActive !== undefined && { isActive }),
            updatedAt: new Date(),
          },
        });
      }

      // 2) 운동 수정/추가 + 순서 이동
      let added = 0;
      let modified = 0;

      if (Array.isArray(exercises) && exercises.length > 0) {
        // 트랜잭션 기준 최신 상태 확보
        let current = await tx.routineExercise.findMany({
          where: { routineId },
          include: { equipment: true },
          orderBy: { order: "asc" },
        });
        const byEquipId = new Map(current.map((e) => [e.equipmentId, e]));

        // === 0-based 입력 정규화 판단 ===
        const incomingOrderNums = exercises
          .filter((e) => e && e.order !== undefined && e.order !== null)
          .map((e) => Number(e.order))
          .filter(Number.isFinite);
        const zeroBased =
          incomingOrderNums.length > 0 && Math.min(...incomingOrderNums) === 0;

        const normalizeOrder = (ord, maxLen) => {
          if (ord === undefined || ord === null) return undefined;
          const n = Number(ord);
          if (!Number.isFinite(n)) return undefined;
          const oneBased = zeroBased ? n + 1 : n;
          // 1..N 범위로 클램프
          const N = Math.max(1, maxLen);
          return Math.max(1, Math.min(oneBased, N));
        };

        // 임시 큰 순번(충돌 회피용)
        const curMax = current.length
          ? Math.max(...current.map((e) => e.order))
          : 0;
        let tempOrderSeed = curMax + 100;

        // 마지막에 한 번에 적용할 "희망 이동 목록"
        const preferredMoves = [];

        for (const item of exercises) {
          if (!item || typeof item.equipmentId !== "number") continue;

          const {
            equipmentId,
            order,
            targetSets,
            targetReps,
            restSeconds,
            notes,
          } = item;

          // 기구 검증
          const eq = await tx.equipment.findUnique({
            where: { id: equipmentId },
          });
          if (!eq) throw new Error(`기구 ID ${equipmentId}를 찾을 수 없습니다`);

          const exist = byEquipId.get(equipmentId);

          if (exist) {
            // 순서 제외 필드만 즉시 업데이트 (0도 허용이므로 undefined/null만 거르기)
            const updateData = {};
            if (targetSets !== undefined) updateData.targetSets = targetSets;
            if (targetReps !== undefined) updateData.targetReps = targetReps;
            if (restSeconds !== undefined) updateData.restSeconds = restSeconds;
            if (notes !== undefined) updateData.notes = notes;

            if (Object.keys(updateData).length > 0) {
              await tx.routineExercise.update({
                where: { id: exist.id },
                data: updateData,
              });
              modified++;
            }

            // 순서는 일괄 재정렬에서 컷-인서트로 처리
            const norm = normalizeOrder(order, current.length);
            if (norm !== undefined)
              preferredMoves.push({ id: exist.id, order: norm });
          } else {
            // 신규는 임시 큰 순번으로 생성
            const created = await tx.routineExercise.create({
              data: {
                routineId,
                equipmentId,
                order: tempOrderSeed++, // 충돌 회피
                targetSets: targetSets ?? 3,
                targetReps,
                restSeconds: restSeconds ?? 180,
                notes,
              },
              include: { equipment: true },
            });
            added++;
            current.push(created);
            byEquipId.set(equipmentId, created);

            const norm = normalizeOrder(order, current.length);
            if (norm !== undefined)
              preferredMoves.push({ id: created.id, order: norm });
          }
        }

        // === 마지막에 한 번에 컷-인서트 재정렬 ===
        await reorderExercises(tx, routineId, preferredMoves);
      }

      // 최신 상태 반환
      const fresh = await tx.workoutRoutine.findUnique({
        where: { id: routineId },
        include: {
          exercises: {
            include: { equipment: true },
            orderBy: { order: "asc" },
          },
        },
      });

      // 응답 메시지
      let message = "루틴이 수정되었습니다";
      if (Array.isArray(exercises) && exercises.length > 0) {
        if (added > 0 && modified > 0)
          message = `${modified}개 운동 수정, ${added}개 운동 추가`;
        else if (added > 0) message = `${added}개 운동이 추가되었습니다`;
        else if (modified > 0) message = `${modified}개 운동이 수정되었습니다`;
      }

      return { message, routine: fresh };
    }); // tx 끝

    res.json(updated);
  }),
);

// PUT /api/routines/:id - 기존 방식 (전체 교체)
router.put(
  "/:id",
  auth(),
  asyncRoute(async (req, res) => {
    const routineId = parseInt(req.params.id, 10);
    const v = updateRoutineSchema.safeParse(req.body);

    if (!v.success) {
      return res.status(400).json({
        error: "입력 데이터가 올바르지 않습니다",
        details: v.error.issues,
      });
    }

    const { name, isActive, exercises } = v.data;

    // 루틴 소유권 확인
    const existing = await prisma.workoutRoutine.findFirst({
      where: { id: routineId, userId: req.user.id },
      include: { exercises: true },
    });

    if (!existing) {
      return res.status(404).json({ error: "루틴을 찾을 수 없습니다" });
    }

    // 🆕 exercises가 제공된 경우, 기구 존재 여부 검증
    if (exercises && exercises.length > 0) {
      const equipmentIds = exercises.map((e) => e.equipmentId);
      const existingEquipment = await prisma.equipment.count({
        where: { id: { in: equipmentIds } },
      });

      if (existingEquipment !== equipmentIds.length) {
        return res.status(400).json({
          error: "존재하지 않는 기구가 포함되어 있습니다",
        });
      }
    }

    // 트랜잭션으로 원자적 업데이트
    const updated = await prisma.$transaction(async (tx) => {
      // 1. 루틴 기본 정보 업데이트
      const updateData = { updatedAt: new Date() };
      if (name !== undefined) updateData.name = name;
      if (isActive !== undefined) updateData.isActive = isActive;

      await tx.workoutRoutine.update({
        where: { id: routineId },
        data: updateData,
      });

      // 2. 운동 목록이 제공된 경우, 전체 교체
      if (exercises !== undefined) {
        // 기존 운동 전체 삭제
        await tx.routineExercise.deleteMany({
          where: { routineId },
        });

        // 새 운동 목록 생성 (order는 배열 순서대로)
        if (exercises.length > 0) {
          await tx.routineExercise.createMany({
            data: exercises.map((e, index) => ({
              routineId,
              equipmentId: e.equipmentId,
              order: index + 1, // 배열 순서가 곧 order
              targetSets: e.targetSets ?? 3,
              targetReps: e.targetReps ?? null,
              restSeconds: e.restSeconds ?? 180,
              notes: e.notes ?? null,
            })),
          });
        }
      }

      // 3. 업데이트된 전체 루틴 반환
      return tx.workoutRoutine.findUnique({
        where: { id: routineId },
        include: {
          exercises: {
            include: { equipment: true },
            orderBy: { order: "asc" },
          },
          _count: { select: { exercises: true } },
        },
      });
    });

    res.json({
      message: "루틴이 성공적으로 업데이트되었습니다",
      routine: {
        id: updated.id,
        name: updated.name,
        isActive: updated.isActive,
        exerciseCount: updated._count.exercises,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
        exercises: updated.exercises.map((ex) => ({
          id: ex.id,
          order: ex.order,
          targetSets: ex.targetSets,
          targetReps: ex.targetReps,
          restSeconds: ex.restSeconds,
          notes: ex.notes,
          equipment: ex.equipment,
        })),
      },
    });
  }),
);

// 🆕 POST /api/routines/:id/exercises - 루틴에 운동 추가/업데이트
router.post(
  "/:id/exercises",
  auth(),
  asyncRoute(async (req, res) => {
    const routineId = parseInt(req.params.id, 10);
    const v = addExerciseSchema.safeParse(req.body);
    if (!v.success)
      return res.status(400).json({
        error: "입력 데이터가 올바르지 않습니다",
        details: v.error.issues,
      });

    const {
      equipmentId,
      targetSets = 3,
      targetReps,
      restSeconds = 180,
      notes,
    } = v.data;

    // 루틴 소유권 확인
    const routine = await prisma.workoutRoutine.findFirst({
      where: { id: routineId, userId: req.user.id },
    });
    if (!routine)
      return res.status(404).json({ error: "루틴을 찾을 수 없습니다" });

    // 기구 존재 확인
    const equipment = await prisma.equipment.findUnique({
      where: { id: equipmentId },
    });
    if (!equipment)
      return res.status(404).json({ error: "기구를 찾을 수 없습니다" });

    const result = await prisma.$transaction(async (tx) => {
      // 기존 운동이 있는지 확인
      const existingExercise = await tx.routineExercise.findUnique({
        where: { routineId_equipmentId: { routineId, equipmentId } },
      });

      if (existingExercise) {
        // 기존 운동 업데이트
        const updatedExercise = await tx.routineExercise.update({
          where: { id: existingExercise.id },
          data: { targetSets, targetReps, restSeconds, notes },
          include: { equipment: true },
        });
        return { action: "updated", exercise: updatedExercise };
      } else {
        // 새 운동 추가 - 마지막 순서로
        const maxOrder = await tx.routineExercise.findFirst({
          where: { routineId },
          orderBy: { order: "desc" },
          select: { order: true },
        });

        const newExercise = await tx.routineExercise.create({
          data: {
            routineId,
            equipmentId,
            order: (maxOrder?.order || 0) + 1,
            targetSets,
            targetReps,
            restSeconds,
            notes,
          },
          include: { equipment: true },
        });
        return { action: "added", exercise: newExercise };
      }
    });

    res.status(result.action === "added" ? 201 : 200).json({
      message:
        result.action === "added"
          ? "운동이 루틴에 추가되었습니다"
          : "운동이 업데이트되었습니다",
      action: result.action,
      exercise: {
        id: result.exercise.id,
        order: result.exercise.order,
        targetSets: result.exercise.targetSets,
        targetReps: result.exercise.targetReps,
        restSeconds: result.exercise.restSeconds,
        notes: result.exercise.notes,
        equipment: result.exercise.equipment,
      },
    });
  }),
);

// 🆕 PATCH /api/routines/:routineId/exercises/:exerciseId - 개별 운동 수정
router.patch(
  "/:routineId/exercises/:exerciseId",
  auth(),
  asyncRoute(async (req, res) => {
    const routineId = parseInt(req.params.routineId, 10);
    const exerciseId = parseInt(req.params.exerciseId, 10);
    const { targetSets, targetReps, restSeconds, notes } = req.body;

    // 소유권 확인
    const exercise = await prisma.routineExercise.findFirst({
      where: { id: exerciseId, routineId, routine: { userId: req.user.id } },
      include: { equipment: true, routine: true },
    });
    if (!exercise)
      return res.status(404).json({ error: "운동을 찾을 수 없습니다" });

    // 업데이트할 데이터만 필터링
    const updateData = {};
    if (targetSets !== undefined) updateData.targetSets = targetSets;
    if (targetReps !== undefined) updateData.targetReps = targetReps;
    if (restSeconds !== undefined) updateData.restSeconds = restSeconds;
    if (notes !== undefined) updateData.notes = notes;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "업데이트할 데이터가 없습니다" });
    }

    const updated = await prisma.routineExercise.update({
      where: { id: exerciseId },
      data: updateData,
      include: { equipment: true },
    });

    res.json({
      message: "운동이 업데이트되었습니다",
      exercise: {
        id: updated.id,
        order: updated.order,
        targetSets: updated.targetSets,
        targetReps: updated.targetReps,
        restSeconds: updated.restSeconds,
        notes: updated.notes,
        equipment: updated.equipment,
      },
    });
  }),
);

// DELETE /api/routines/:id
router.delete(
  "/:id",
  auth(),
  asyncRoute(async (req, res) => {
    const routineId = parseInt(req.params.id, 10);
    const routine = await prisma.workoutRoutine.findFirst({
      where: { id: routineId, userId: req.user.id },
    });
    if (!routine)
      return res.status(404).json({ error: "루틴을 찾을 수 없습니다" });
    await prisma.workoutRoutine.delete({ where: { id: routineId } });
    res.status(204).end();
  }),
);

// POST /api/routines/:routineId/exercises/:exerciseId/start
router.post(
  "/:routineId/exercises/:exerciseId/start",
  auth(),
  asyncRoute(async (req, res) => {
    const { routineId, exerciseId } = req.params;
    const { totalSets, restSeconds } = req.body;

    const exercise = await prisma.routineExercise.findFirst({
      where: {
        id: parseInt(exerciseId, 10),
        routineId: parseInt(routineId, 10),
        routine: { userId: req.user.id },
      },
      include: { equipment: true, routine: true },
    });
    if (!exercise)
      return res.status(404).json({ error: "운동 항목을 찾을 수 없습니다" });

    const equipmentId = exercise.equipmentId;
    const sets = totalSets || exercise.targetSets;
    const restSec = restSeconds ?? exercise.restSeconds;

    const currentUsage = await prisma.equipmentUsage.findFirst({
      where: { equipmentId, status: "IN_USE" },
    });
    if (currentUsage && currentUsage.userId !== req.user.id) {
      return res.status(409).json({
        error: "기구가 사용 중입니다",
        message: "대기열에 등록하거나 나중에 다시 시도해주세요",
      });
    }

    const myUsage = await prisma.equipmentUsage.findFirst({
      where: { userId: req.user.id, status: "IN_USE" },
    });
    if (myUsage && myUsage.equipmentId !== equipmentId) {
      return res.status(409).json({
        error: "이미 다른 기구를 사용 중입니다",
        currentEquipmentId: myUsage.equipmentId,
      });
    }

    // 🔥 수정: estimatedEndAt 계산을 초 단위로 통일
    const workTimeSeconds = sets * 5 * 60; // 5분/세트
    const restTimeSeconds = (sets - 1) * restSec; // 세트간 휴식
    const totalDurationSeconds = workTimeSeconds + restTimeSeconds;

    const usage = await prisma.$transaction(async (tx) => {
      await deactivateOldRoutines(req.user.id, tx);
      // 1) 내 모든 루틴 비활성화
      await tx.workoutRoutine.updateMany({
        where: { userId: req.user.id, isActive: true },
        data: { isActive: false },
      });

      // 2) 이번에 시작한 루틴 활성화
      await tx.workoutRoutine.update({
        where: { id: Number(routineId) },
        data: { isActive: true, updatedAt: new Date() },
      });

      // 3) 기구 사용 시작 레코드 생성 (기존 그대로)
      return tx.equipmentUsage.create({
        data: {
          equipmentId,
          userId: req.user.id,
          totalSets: sets,
          restSeconds: restSec,
          status: "IN_USE",
          setStatus: "EXERCISING",
          currentSet: 1,
          currentSetStartedAt: new Date(),
          estimatedEndAt: new Date(Date.now() + totalDurationSeconds * 1000),
        },
      });
    });

    res.json({
      message: `${exercise.equipment.name} 사용을 시작했습니다`,
      equipmentName: exercise.equipment.name,
      totalSets: sets,
      restSeconds: restSec,
      usageId: usage.id,
    });
  }),
);

// 🆕 PUT /api/routines/active-usage/rest-time - 진행중인 운동의 휴식시간 조정
router.put(
  "/active-usage/rest-time",
  auth(),
  asyncRoute(async (req, res) => {
    const { adjustment } = req.body; // +10 또는 -10 (초)

    if (!adjustment || ![10, -10].includes(adjustment)) {
      return res
        .status(400)
        .json({ error: "조정값은 +10 또는 -10이어야 합니다" });
    }

    const usage = await prisma.equipmentUsage.findFirst({
      where: { userId: req.user.id, status: "IN_USE" },
      include: { equipment: true },
    });

    if (!usage) {
      return res.status(404).json({ error: "현재 사용 중인 기구가 없습니다" });
    }

    // 새로운 휴식시간 계산
    const newRestSeconds = Math.max(0, usage.restSeconds + adjustment);

    // 🔥 예상 종료 시간 재계산
    const now = new Date();
    const remainingSets = Math.max(0, usage.totalSets - usage.currentSet + 1);

    // 현재 세트의 남은 시간 계산
    let currentSetRemaining = 0;
    if (usage.setStatus === "EXERCISING" && usage.currentSetStartedAt) {
      const setElapsed = Math.floor((now - usage.currentSetStartedAt) / 1000);
      currentSetRemaining = Math.max(0, 5 * 60 - setElapsed); // 세트당 5분 가정
    } else if (usage.setStatus === "RESTING" && usage.restStartedAt) {
      const restElapsed = Math.floor((now - usage.restStartedAt) / 1000);
      currentSetRemaining = Math.max(0, newRestSeconds - restElapsed); // 변경된 휴식시간 적용
    }

    // 남은 전체 시간 계산
    const futureWorkTime = Math.max(0, remainingSets - 1) * 5 * 60; // 남은 세트들의 운동 시간
    const futureRestTime = Math.max(0, remainingSets - 1) * newRestSeconds; // 남은 세트들의 휴식 시간 (변경된 값 적용)
    const totalRemainingSeconds =
      currentSetRemaining + futureWorkTime + futureRestTime;

    const newEstimatedEndAt = new Date(
      now.getTime() + totalRemainingSeconds * 1000,
    );

    // 업데이트
    const updated = await prisma.equipmentUsage.update({
      where: { id: usage.id },
      data: {
        restSeconds: newRestSeconds,
        estimatedEndAt: newEstimatedEndAt, // 🔥 예상 종료 시간도 함께 업데이트
      },
    });

    res.json({
      message: `휴식시간이 ${adjustment > 0 ? "증가" : "감소"}했습니다`,
      equipmentName: usage.equipment.name,
      previousRestSeconds: usage.restSeconds,
      newRestSeconds: newRestSeconds,
      adjustment: adjustment,
      currentSet: updated.currentSet,
      totalSets: updated.totalSets,
      setStatus: updated.setStatus,
      estimatedEndAt: updated.estimatedEndAt, // 🆕 변경된 예상 종료 시간 포함
      remainingMinutes: Math.ceil(totalRemainingSeconds / 60), // 🆕 남은 예상 시간(분)
    });
  }),
);

// ==========================================
// 🆕 간단한 루틴 시작 API
// ==========================================

// ==========================================
// 🆕 POST /api/routines/:routineId/start/:equipmentId
// URL에 equipmentId 포함 - 가장 명확하고 RESTful한 방식!
// ==========================================
router.post(
  "/:routineId/start/:equipmentId",
  auth(),
  asyncRoute(async (req, res) => {
    const routineId = parseInt(req.params.routineId, 10);
    const equipmentId = parseInt(req.params.equipmentId, 10);
    const { totalSets, restSeconds } = req.body;

    // 1. 루틴 존재 및 소유권 확인
    const routine = await prisma.workoutRoutine.findFirst({
      where: { id: routineId, userId: req.user.id },
      include: {
        exercises: {
          include: { equipment: true },
          orderBy: { order: "asc" },
        },
      },
    });

    if (!routine) {
      return res.status(404).json({ error: "루틴을 찾을 수 없습니다" });
    }

    // 2. 해당 기구가 루틴에 포함되어 있는지 확인
    const exercise = routine.exercises.find(
      (ex) => ex.equipmentId === equipmentId,
    );

    if (!exercise) {
      return res.status(404).json({
        error: "해당 기구가 이 루틴에 없습니다",
        equipmentId: equipmentId,
        routineName: routine.name,
        availableEquipments: routine.exercises.map((ex) => ({
          equipmentId: ex.equipmentId,
          equipmentName: ex.equipment.name,
          order: ex.order,
        })),
        suggestion: "위 기구 중 하나를 선택해주세요",
      });
    }

    // 3. 기구 사용 가능 여부 확인
    const currentUsage = await prisma.equipmentUsage.findFirst({
      where: { equipmentId, status: "IN_USE" },
      include: { user: { select: { name: true } } },
    });

    if (currentUsage && currentUsage.userId !== req.user.id) {
      return res.status(409).json({
        error: "기구가 사용 중입니다",
        equipmentName: exercise.equipment.name,
        currentUser: currentUsage.user.name,
        startedAt: currentUsage.startedAt,
        suggestion: "대기열에 등록하거나 루틴의 다른 운동을 먼저 하세요",
      });
    }

    // 4. 이미 다른 기구 사용 중인지 확인
    const myUsage = await prisma.equipmentUsage.findFirst({
      where: { userId: req.user.id, status: "IN_USE" },
      include: { equipment: true },
    });

    if (myUsage && myUsage.equipmentId !== equipmentId) {
      return res.status(409).json({
        error: "이미 다른 기구를 사용 중입니다",
        currentEquipment: myUsage.equipment.name,
        currentEquipmentId: myUsage.equipmentId,
        requestedEquipment: exercise.equipment.name,
        suggestion: "현재 운동을 완료한 후 다시 시도하세요",
      });
    }

    // 5. 운동 설정 (body 또는 루틴 기본값 사용)
    const sets = totalSets || exercise.targetSets || 3;
    const restSec =
      restSeconds !== undefined ? restSeconds : exercise.restSeconds || 180;

    // 6. 예상 종료 시간 계산
    const workTimeSeconds = sets * 5 * 60; // 5분/세트
    const restTimeSeconds = (sets - 1) * restSec;
    const totalDurationSeconds = workTimeSeconds + restTimeSeconds;

    // 7. 트랜잭션으로 루틴 활성화 + 운동 시작
    const usage = await prisma.$transaction(async (tx) => {
      await deactivateOldRoutines(req.user.id, tx);
      // 내 모든 루틴 비활성화
      await tx.workoutRoutine.updateMany({
        where: { userId: req.user.id, isActive: true },
        data: { isActive: false },
      });

      // 이 루틴 활성화
      await tx.workoutRoutine.update({
        where: { id: routineId },
        data: { isActive: true, updatedAt: new Date() },
      });

      // 🔥 대기열에 있었으면 COMPLETED 처리 + 재정렬
      const firstInQueue = await tx.waitingQueue.findFirst({
        where: { equipmentId, status: { in: ["WAITING", "NOTIFIED"] } },
        orderBy: { queuePosition: "asc" },
      });

      if (firstInQueue && firstInQueue.userId === req.user.id) {
        await tx.waitingQueue.update({
          where: { id: firstInQueue.id },
          data: { status: "COMPLETED" },
        });

        const {
          reorderQueueInTransaction,
        } = require("../services/waiting.service");
        await reorderQueueInTransaction(tx, equipmentId);
      }

      // 기구 사용 시작
      return tx.equipmentUsage.create({
        data: {
          equipmentId,
          userId: req.user.id,
          totalSets: sets,
          restSeconds: restSec,
          status: "IN_USE",
          setStatus: "EXERCISING",
          currentSet: 1,
          currentSetStartedAt: new Date(),
          estimatedEndAt: new Date(Date.now() + totalDurationSeconds * 1000),
        },
        include: { equipment: true },
      });
    });

    // 8. 성공 응답
    res.json({
      message: `${routine.name}: ${exercise.equipment.name} 시작`,
      routine: {
        id: routine.id,
        name: routine.name,
        isActive: true,
      },
      equipment: {
        id: exercise.equipmentId,
        name: exercise.equipment.name,
        category: exercise.equipment.category,
        imageUrl: exercise.equipment.imageUrl,
      },
      workout: {
        usageId: usage.id,
        totalSets: sets,
        restSeconds: restSec,
        currentSet: 1,
        setStatus: "EXERCISING",
        startedAt: usage.startedAt,
        estimatedEndAt: usage.estimatedEndAt,
      },
      exerciseInfo: {
        order: exercise.order,
        targetReps: exercise.targetReps,
        notes: exercise.notes,
      },
      nextExercises: routine.exercises
        .filter((ex) => ex.order > exercise.order)
        .map((ex) => ({
          equipmentId: ex.equipmentId,
          equipmentName: ex.equipment.name,
          order: ex.order,
        })),
    });
  }),
);

// ==========================================
// 🆕 간단한 루틴 수정 API들
// ==========================================

/**
 * PATCH /api/routines/:routineId/name
 * 루틴 이름만 변경
 */
router.patch(
  "/:routineId/name",
  auth(),
  asyncRoute(async (req, res) => {
    const routineId = parseInt(req.params.routineId, 10);
    const { name } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: "루틴 이름을 입력하세요" });
    }

    const routine = await prisma.workoutRoutine.findFirst({
      where: { id: routineId, userId: req.user.id },
    });

    if (!routine) {
      return res.status(404).json({ error: "루틴을 찾을 수 없습니다" });
    }

    const updated = await prisma.workoutRoutine.update({
      where: { id: routineId },
      data: { name: name.trim(), updatedAt: new Date() },
    });

    res.json({
      message: "루틴 이름이 변경되었습니다",
      id: updated.id,
      name: updated.name,
    });
  }),
);

/**
 * POST /api/routines/:routineId/exercises/add
 * 루틴에 기구 하나 추가
 */
router.post(
  "/:routineId/exercises/add",
  auth(),
  asyncRoute(async (req, res) => {
    const routineId = parseInt(req.params.routineId, 10);
    const { equipmentId, targetSets, restSeconds, notes } = req.body;

    if (!equipmentId) {
      return res.status(400).json({ error: "equipmentId가 필요합니다" });
    }

    // 루틴 소유권 확인
    const routine = await prisma.workoutRoutine.findFirst({
      where: { id: routineId, userId: req.user.id },
    });

    if (!routine) {
      return res.status(404).json({ error: "루틴을 찾을 수 없습니다" });
    }

    // 기구 존재 확인
    const equipment = await prisma.equipment.findUnique({
      where: { id: equipmentId },
    });

    if (!equipment) {
      return res.status(404).json({ error: "기구를 찾을 수 없습니다" });
    }

    // 이미 루틴에 있는지 확인
    const existing = await prisma.routineExercise.findUnique({
      where: { routineId_equipmentId: { routineId, equipmentId } },
    });

    if (existing) {
      return res.status(409).json({
        error: "이미 루틴에 있는 기구입니다",
        equipmentName: equipment.name,
      });
    }

    // 마지막 순서 찾기
    const maxOrder = await prisma.routineExercise.findFirst({
      where: { routineId },
      orderBy: { order: "desc" },
      select: { order: true },
    });

    // 기구 추가
    const exercise = await prisma.routineExercise.create({
      data: {
        routineId,
        equipmentId,
        order: (maxOrder?.order || 0) + 1,
        targetSets: targetSets || 3,
        restSeconds: restSeconds || 180,
        notes: notes || null,
      },
      include: { equipment: true },
    });

    res.status(201).json({
      message: `${equipment.name}이(가) 루틴에 추가되었습니다`,
      exercise: {
        id: exercise.id,
        equipmentId: exercise.equipmentId,
        equipmentName: exercise.equipment.name,
        order: exercise.order,
        targetSets: exercise.targetSets,
        restSeconds: exercise.restSeconds,
        notes: exercise.notes,
      },
    });
  }),
);

/**
 * DELETE /api/routines/:routineId/exercises/:equipmentId
 * 루틴에서 특정 기구 삭제
 */
router.delete(
  "/:routineId/exercises/:equipmentId",
  auth(),
  asyncRoute(async (req, res) => {
    const routineId = parseInt(req.params.routineId, 10);
    const equipmentId = parseInt(req.params.equipmentId, 10);

    // 루틴 소유권 확인
    const routine = await prisma.workoutRoutine.findFirst({
      where: { id: routineId, userId: req.user.id },
    });

    if (!routine) {
      return res.status(404).json({ error: "루틴을 찾을 수 없습니다" });
    }

    // 운동 찾기
    const exercise = await prisma.routineExercise.findUnique({
      where: { routineId_equipmentId: { routineId, equipmentId } },
      include: { equipment: true },
    });

    if (!exercise) {
      return res.status(404).json({ error: "루틴에 해당 기구가 없습니다" });
    }

    // 삭제 및 순서 재정렬
    await prisma.$transaction(async (tx) => {
      // 기구 삭제
      await tx.routineExercise.delete({
        where: { id: exercise.id },
      });

      // 남은 운동들의 순서 재정렬
      const remaining = await tx.routineExercise.findMany({
        where: { routineId },
        orderBy: { order: "asc" },
      });

      for (let i = 0; i < remaining.length; i++) {
        if (remaining[i].order !== i + 1) {
          await tx.routineExercise.update({
            where: { id: remaining[i].id },
            data: { order: i + 1 },
          });
        }
      }
    });

    res.json({
      message: `${exercise.equipment.name}이(가) 루틴에서 삭제되었습니다`,
      deletedEquipment: {
        equipmentId: exercise.equipmentId,
        equipmentName: exercise.equipment.name,
      },
    });
  }),
);

/**
 * PATCH /api/routines/:routineId/exercises/:equipmentId/sets
 * 특정 기구의 세트 수만 변경
 */
router.patch(
  "/:routineId/exercises/:equipmentId/sets",
  auth(),
  asyncRoute(async (req, res) => {
    const routineId = parseInt(req.params.routineId, 10);
    const equipmentId = parseInt(req.params.equipmentId, 10);
    const { targetSets } = req.body;

    if (!targetSets || targetSets < 1 || targetSets > 20) {
      return res.status(400).json({ error: "세트 수는 1~20 사이여야 합니다" });
    }

    // 운동 찾기 및 소유권 확인
    const exercise = await prisma.routineExercise.findFirst({
      where: {
        routineId,
        equipmentId,
        routine: { userId: req.user.id },
      },
      include: { equipment: true },
    });

    if (!exercise) {
      return res.status(404).json({ error: "루틴에 해당 기구가 없습니다" });
    }

    // 세트 수 업데이트
    const updated = await prisma.routineExercise.update({
      where: { id: exercise.id },
      data: { targetSets },
    });

    res.json({
      message: `${exercise.equipment.name} 세트 수가 변경되었습니다`,
      equipmentName: exercise.equipment.name,
      previousSets: exercise.targetSets,
      newSets: updated.targetSets,
    });
  }),
);

/**
 * PATCH /api/routines/:routineId/exercises/:equipmentId/rest
 * 특정 기구의 휴식 시간만 변경
 */
router.patch(
  "/:routineId/exercises/:equipmentId/rest",
  auth(),
  asyncRoute(async (req, res) => {
    const routineId = parseInt(req.params.routineId, 10);
    const equipmentId = parseInt(req.params.equipmentId, 10);
    const { restSeconds } = req.body;

    if (restSeconds === undefined || restSeconds < 0 || restSeconds > 900) {
      return res
        .status(400)
        .json({ error: "휴식 시간은 0~900초 사이여야 합니다" });
    }

    // 운동 찾기 및 소유권 확인
    const exercise = await prisma.routineExercise.findFirst({
      where: {
        routineId,
        equipmentId,
        routine: { userId: req.user.id },
      },
      include: { equipment: true },
    });

    if (!exercise) {
      return res.status(404).json({ error: "루틴에 해당 기구가 없습니다" });
    }

    // 휴식 시간 업데이트
    const updated = await prisma.routineExercise.update({
      where: { id: exercise.id },
      data: { restSeconds },
    });

    res.json({
      message: `${exercise.equipment.name} 휴식 시간이 변경되었습니다`,
      equipmentName: exercise.equipment.name,
      previousRest: exercise.restSeconds,
      newRest: updated.restSeconds,
      restMinutes: Math.round(updated.restSeconds / 60),
    });
  }),
);

/**
 * PATCH /api/routines/:routineId/exercises/:equipmentId/order
 * 특정 기구의 순서 변경
 */
router.patch(
  "/:routineId/exercises/:equipmentId/order",
  auth(),
  asyncRoute(async (req, res) => {
    const routineId = parseInt(req.params.routineId, 10);
    const equipmentId = parseInt(req.params.equipmentId, 10);
    const { newOrder } = req.body;

    if (!newOrder || newOrder < 1) {
      return res
        .status(400)
        .json({ error: "올바른 순서를 입력하세요 (1 이상)" });
    }

    // 루틴 소유권 확인
    const routine = await prisma.workoutRoutine.findFirst({
      where: { id: routineId, userId: req.user.id },
      include: {
        exercises: {
          include: { equipment: true },
          orderBy: { order: "asc" },
        },
      },
    });

    if (!routine) {
      return res.status(404).json({ error: "루틴을 찾을 수 없습니다" });
    }

    // 대상 운동 찾기
    const targetExercise = routine.exercises.find(
      (ex) => ex.equipmentId === equipmentId,
    );

    if (!targetExercise) {
      return res.status(404).json({ error: "루틴에 해당 기구가 없습니다" });
    }

    const maxOrder = routine.exercises.length;
    const finalNewOrder = Math.min(newOrder, maxOrder);
    const oldOrder = targetExercise.order;

    if (oldOrder === finalNewOrder) {
      return res.json({
        message: "순서가 변경되지 않았습니다",
        equipmentName: targetExercise.equipment.name,
        order: oldOrder,
      });
    }

    // 순서 재정렬
    await prisma.$transaction(async (tx) => {
      if (finalNewOrder < oldOrder) {
        // 위로 이동: 사이 운동들을 아래로
        await tx.routineExercise.updateMany({
          where: {
            routineId,
            order: { gte: finalNewOrder, lt: oldOrder },
          },
          data: { order: { increment: 1 } },
        });
      } else {
        // 아래로 이동: 사이 운동들을 위로
        await tx.routineExercise.updateMany({
          where: {
            routineId,
            order: { gt: oldOrder, lte: finalNewOrder },
          },
          data: { order: { decrement: 1 } },
        });
      }

      // 대상 운동 순서 변경
      await tx.routineExercise.update({
        where: { id: targetExercise.id },
        data: { order: finalNewOrder },
      });
    });

    res.json({
      message: `${targetExercise.equipment.name} 순서가 변경되었습니다`,
      equipmentName: targetExercise.equipment.name,
      previousOrder: oldOrder,
      newOrder: finalNewOrder,
    });
  }),
);

/**
 * POST /api/routines/:routineId/queue/:equipmentId
 * 루틴의 특정 운동을 대기열에 등록
 */
router.post(
  "/:routineId/queue/:equipmentId",
  auth(),
  asyncRoute(async (req, res) => {
    const routineId = parseInt(req.params.routineId, 10);
    const equipmentId = parseInt(req.params.equipmentId, 10);

    // 1. 루틴 존재 및 소유권 확인
    const routine = await prisma.workoutRoutine.findFirst({
      where: { id: routineId, userId: req.user.id },
      include: {
        exercises: {
          include: { equipment: true },
          orderBy: { order: "asc" },
        },
      },
    });

    if (!routine) {
      return res.status(404).json({ error: "루틴을 찾을 수 없습니다" });
    }

    // 2. 해당 기구가 루틴에 포함되어 있는지 확인
    const exercise = routine.exercises.find(
      (ex) => ex.equipmentId === equipmentId,
    );
    if (!exercise) {
      return res.status(404).json({
        error: "해당 기구가 이 루틴에 없습니다",
        equipmentId: equipmentId,
        routineName: routine.name,
        availableEquipments: routine.exercises.map((ex) => ({
          equipmentId: ex.equipmentId,
          equipmentName: ex.equipment.name,
          order: ex.order,
        })),
        suggestion: "위 기구 중 하나를 선택해주세요",
      });
    }

    // 3. 기구 존재 확인
    const equipment = await prisma.equipment.findUnique({
      where: { id: equipmentId },
    });

    if (!equipment) {
      return res.status(404).json({ error: "기구를 찾을 수 없습니다" });
    }

    // 4. 이미 대기열에 등록되어 있는지 확인
    const existingQueue = await prisma.waitingQueue.findFirst({
      where: {
        equipmentId,
        userId: req.user.id,
        status: { in: ["WAITING", "NOTIFIED"] },
      },
    });

    if (existingQueue) {
      return res.status(409).json({
        error: "이미 대기열에 등록되어 있습니다",
        equipmentName: equipment.name,
        queuePosition: existingQueue.queuePosition,
        status: existingQueue.status,
      });
    }

    // 5. 현재 사용 중인 기구 확인
    const myUsage = await prisma.equipmentUsage.findFirst({
      where: { userId: req.user.id, status: "IN_USE" },
      include: { equipment: { select: { name: true } } },
    });

    if (myUsage) {
      if (myUsage.equipmentId === equipmentId) {
        return res.status(409).json({
          error: "현재 사용 중인 기구입니다",
          message: "사용이 완료된 후 다시 대기할 수 있습니다",
          currentEquipment: myUsage.equipment.name,
          equipmentId: myUsage.equipmentId,
        });
      }
    }

    // 6. 대기열 등록
    const length = await prisma.waitingQueue.count({
      where: { equipmentId, status: { in: ["WAITING", "NOTIFIED"] } },
    });

    const queue = await prisma.waitingQueue.create({
      data: {
        equipmentId,
        userId: req.user.id,
        queuePosition: length + 1,
        status: "WAITING",
      },
      include: {
        equipment: true,
        user: { select: { name: true } },
      },
    });

    // 7. 예상 대기시간 계산
    const currentUsage = await prisma.equipmentUsage.findFirst({
      where: { equipmentId: equipmentId, status: "IN_USE" },
    });

    let estimatedWaitMinutes = 0;
    if (currentUsage) {
      const { calculateRealTimeETA, buildQueueETAs } = require("../utils/eta");
      const queueList = await prisma.waitingQueue.findMany({
        where: {
          equipmentId: equipmentId,
          status: { in: ["WAITING", "NOTIFIED"] },
        },
        orderBy: { queuePosition: "asc" },
      });
      const currentETA = calculateRealTimeETA(currentUsage);
      const etas = buildQueueETAs(currentETA, queueList);
      const idx = queueList.findIndex((q) => q.id === queue.id);
      estimatedWaitMinutes = etas[idx] ?? 0;
    } else {
      // 🔥 추가: 기구가 비어있을 때 ETA는 대기 순서 기반으로 계산
      // 1번: 즉시 가능 (0분)
      // 2번 이상: 앞사람들의 예상 시간 누적
      const { TYPICAL_BLOCK_MIN } = require("../utils/eta");
      estimatedWaitMinutes = (queue.queuePosition - 1) * TYPICAL_BLOCK_MIN;
    }

    // 8. 이벤트 발행
    const eventBus = require("../events/eventBus");
    eventBus.emitEquipmentStatusChange(equipmentId, {
      type: "queue_joined",
      equipmentName: equipment.name,
      userName: queue.user.name,
      queuePosition: queue.queuePosition,
      queueId: queue.id,
      routineId: routine.id,
      routineName: routine.name,
    });

    const {
      notifyCurrentUserWaitingCount,
    } = require("../services/waiting.service");
    await notifyCurrentUserWaitingCount(equipmentId);

    // 9. 응답
    const response = {
      message: `${routine.name}: ${equipment.name} 대기열에 등록되었습니다`,
      routine: {
        id: routine.id,
        name: routine.name,
      },
      equipment: {
        id: equipment.id,
        name: equipment.name,
        category: equipment.category,
        imageUrl: equipment.imageUrl,
      },
      queue: {
        queueId: queue.id,
        queuePosition: queue.queuePosition,
        estimatedWaitMinutes,
      },
      exerciseInfo: {
        order: exercise.order,
        targetSets: exercise.targetSets,
        targetReps: exercise.targetReps,
        restSeconds: exercise.restSeconds,
        notes: exercise.notes,
      },
    };

    if (myUsage) {
      response.warning = {
        message:
          myUsage.setStatus === "RESTING"
            ? `현재 ${myUsage.equipment.name}에서 휴식 중입니다. 대기 차례가 오면 알림을 받게 됩니다.`
            : `현재 ${myUsage.equipment.name}에서 운동 중입니다. 운동 완료 전에 대기 차례가 올 수 있으니 주의하세요.`,
        currentEquipment: myUsage.equipment.name,
        currentStatus: myUsage.setStatus,
        canSwitchEquipment: myUsage.setStatus === "RESTING",
      };
    }

    res.status(201).json(response);
  }),
);

module.exports = router;
