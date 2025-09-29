// src/routes/routines.js
const router = require('express').Router();
const { auth } = require('../middleware/auth');
const { createRoutineSchema, updateRoutineSchema, addExerciseSchema } = require('../schemas/routine.schema');
const asyncRoute = require('../utils/asyncRoute');

const prisma = require('../lib/prisma');

// GET /api/routines
router.get('/', auth(), asyncRoute(async (req, res) => {
  const { isActive } = req.query;
  const where = { userId: req.user.id, ...(isActive !== undefined && { isActive: isActive === 'true' }) };

  const routines = await prisma.workoutRoutine.findMany({
    where,
    include: {
      exercises: {
        include: {
          equipment: { select: { id: true, name: true, category: true, muscleGroup: true, imageUrl: true } }
        },
        orderBy: { order: 'asc' },
      },
      _count: { select: { exercises: true } },
    },
    orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
  });

  res.json(routines.map((r) => ({
    id: r.id,
    name: r.name,
    isActive: r.isActive,
    exerciseCount: r._count.exercises,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    exercises: r.exercises.map((ex) => ({
      id: ex.id,
      order: ex.order,
      targetSets: ex.targetSets,
      targetReps: ex.targetReps,
      restSeconds: ex.restSeconds, // 이미 초 단위
      notes: ex.notes,
      equipment: ex.equipment
    })),
  })));
}));

// GET /api/routines/:id
router.get('/:id', auth(), asyncRoute(async (req, res) => {
  const routineId = parseInt(req.params.id, 10);
  const routine = await prisma.workoutRoutine.findFirst({
    where: { id: routineId, userId: req.user.id },
    include: { exercises: { include: { equipment: true }, orderBy: { order: 'asc' } } },
  });
  if (!routine) return res.status(404).json({ error: '루틴을 찾을 수 없습니다' });

  const equipmentIds = routine.exercises.map((e) => e.equipmentId);
  const [currentUsages, waitingQueues, myCurrentUsage, myWaitingQueues] = await Promise.all([
    prisma.equipmentUsage.findMany({
      where: { equipmentId: { in: equipmentIds }, status: 'IN_USE' },
      include: { user: { select: { name: true } } }
    }),
    prisma.waitingQueue.findMany({
      where: { equipmentId: { in: equipmentIds }, status: { in: ['WAITING', 'NOTIFIED'] } },
      orderBy: { queuePosition: 'asc' }
    }),
    prisma.equipmentUsage.findFirst({
      where: { userId: req.user.id, status: 'IN_USE' },
      include: { equipment: true }
    }),
    prisma.waitingQueue.findMany({
      where: { userId: req.user.id, status: { in: ['WAITING', 'NOTIFIED'] }, equipmentId: { in: equipmentIds } }
    }),
  ]);

  const exercises = routine.exercises.map((ex) => {
    const cu = currentUsages.find((u) => u.equipmentId === ex.equipmentId);
    const queueCount = waitingQueues.filter((q) => q.equipmentId === ex.equipmentId).length;
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
        currentUserStartedAt: cu ? cu.startedAt : null,
        waitingCount: queueCount,
        myQueuePosition: myQ ? myQ.queuePosition : null,
        myQueueStatus: myQ ? myQ.status : null,
        canStart: !cu && !myQ && (!myCurrentUsage || myCurrentUsage.equipmentId === ex.equipmentId),
        canQueue: cu && !myQ && (!myCurrentUsage || myCurrentUsage.equipmentId === ex.equipmentId),
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
    currentlyUsing: myCurrentUsage ? {
      equipmentId: myCurrentUsage.equipmentId,
      equipmentName: myCurrentUsage.equipment.name
    } : null
  });
}));

// POST /api/routines
router.post('/', auth(), asyncRoute(async (req, res) => {
  const v = createRoutineSchema.safeParse(req.body);
  if (!v.success) return res.status(400).json({ error: '입력 데이터가 올바르지 않습니다', details: v.error.issues });

  const { name, exercises } = v.data;
  const equipmentIds = exercises.map((e) => e.equipmentId);
  const exists = await prisma.equipment.count({ where: { id: { in: equipmentIds } } });
  if (exists !== equipmentIds.length) return res.status(400).json({ error: '존재하지 않는 기구가 포함되어 있습니다' });

  const routine = await prisma.$transaction(async (tx) => {
    const created = await tx.workoutRoutine.create({ data: { userId: req.user.id, name } });
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
      include: { exercises: { include: { equipment: true }, orderBy: { order: 'asc' } } }
    });
  });

  res.status(201).json({
    id: routine.id,
    name: routine.name,
    isActive: routine.isActive,
    exerciseCount: routine.exercises.length,
    exercises: routine.exercises,
    createdAt: routine.createdAt,
    updatedAt: routine.updatedAt
  });
}));

// PUT /api/routines/:id
router.put('/:id', auth(), asyncRoute(async (req, res) => {
  const routineId = parseInt(req.params.id, 10);
  const v = updateRoutineSchema.safeParse(req.body);
  if (!v.success) return res.status(400).json({ error: '입력 데이터가 올바르지 않습니다', details: v.error.issues });

  const { name, isActive, exercises } = v.data;
  const existing = await prisma.workoutRoutine.findFirst({ where: { id: routineId, userId: req.user.id } });
  if (!existing) return res.status(404).json({ error: '루틴을 찾을 수 없습니다' });

  const updated = await prisma.$transaction(async (tx) => {
    await tx.workoutRoutine.update({
      where: { id: routineId },
      data: { ...(name !== undefined && { name }), ...(isActive !== undefined && { isActive }), updatedAt: new Date() }
    });

    if (exercises) {
      await tx.routineExercise.deleteMany({ where: { routineId } });
      if (exercises.length) {
        await tx.routineExercise.createMany({
          data: exercises.map((e, i) => ({
            routineId,
            equipmentId: e.equipmentId,
            order: i + 1,
            targetSets: e.targetSets ?? 3,
            targetReps: e.targetReps,
            restSeconds: e.restSeconds ?? 180, // 기본값 180초 (3분)
            notes: e.notes,
          })),
        });
      }
    }

    return tx.workoutRoutine.findUnique({
      where: { id: routineId },
      include: { exercises: { include: { equipment: true }, orderBy: { order: 'asc' } } }
    });
  });

  res.json(updated);
}));

// 🆕 POST /api/routines/:id/exercises - 루틴에 운동 추가/업데이트
router.post('/:id/exercises', auth(), asyncRoute(async (req, res) => {
  const routineId = parseInt(req.params.id, 10);
  const v = addExerciseSchema.safeParse(req.body);
  if (!v.success) return res.status(400).json({ error: '입력 데이터가 올바르지 않습니다', details: v.error.issues });

  const { equipmentId, targetSets = 3, targetReps, restSeconds = 180, notes } = v.data;

  // 루틴 소유권 확인
  const routine = await prisma.workoutRoutine.findFirst({
    where: { id: routineId, userId: req.user.id }
  });
  if (!routine) return res.status(404).json({ error: '루틴을 찾을 수 없습니다' });

  // 기구 존재 확인
  const equipment = await prisma.equipment.findUnique({ where: { id: equipmentId } });
  if (!equipment) return res.status(404).json({ error: '기구를 찾을 수 없습니다' });

  const result = await prisma.$transaction(async (tx) => {
    // 기존 운동이 있는지 확인
    const existingExercise = await tx.routineExercise.findUnique({
      where: { routineId_equipmentId: { routineId, equipmentId } }
    });

    if (existingExercise) {
      // 기존 운동 업데이트
      const updatedExercise = await tx.routineExercise.update({
        where: { id: existingExercise.id },
        data: { targetSets, targetReps, restSeconds, notes },
        include: { equipment: true }
      });
      return { action: 'updated', exercise: updatedExercise };
    } else {
      // 새 운동 추가 - 마지막 순서로
      const maxOrder = await tx.routineExercise.findFirst({
        where: { routineId },
        orderBy: { order: 'desc' },
        select: { order: true }
      });
      
      const newExercise = await tx.routineExercise.create({
        data: {
          routineId,
          equipmentId,
          order: (maxOrder?.order || 0) + 1,
          targetSets,
          targetReps,
          restSeconds,
          notes
        },
        include: { equipment: true }
      });
      return { action: 'added', exercise: newExercise };
    }
  });

  res.status(result.action === 'added' ? 201 : 200).json({
    message: result.action === 'added' ? '운동이 루틴에 추가되었습니다' : '운동이 업데이트되었습니다',
    action: result.action,
    exercise: {
      id: result.exercise.id,
      order: result.exercise.order,
      targetSets: result.exercise.targetSets,
      targetReps: result.exercise.targetReps,
      restSeconds: result.exercise.restSeconds,
      notes: result.exercise.notes,
      equipment: result.exercise.equipment
    }
  });
}));

// 🆕 PATCH /api/routines/:routineId/exercises/:exerciseId - 개별 운동 수정
router.patch('/:routineId/exercises/:exerciseId', auth(), asyncRoute(async (req, res) => {
  const routineId = parseInt(req.params.routineId, 10);
  const exerciseId = parseInt(req.params.exerciseId, 10);
  const { targetSets, targetReps, restSeconds, notes } = req.body;

  // 소유권 확인
  const exercise = await prisma.routineExercise.findFirst({
    where: { id: exerciseId, routineId, routine: { userId: req.user.id } },
    include: { equipment: true, routine: true }
  });
  if (!exercise) return res.status(404).json({ error: '운동을 찾을 수 없습니다' });

  // 업데이트할 데이터만 필터링
  const updateData = {};
  if (targetSets !== undefined) updateData.targetSets = targetSets;
  if (targetReps !== undefined) updateData.targetReps = targetReps;
  if (restSeconds !== undefined) updateData.restSeconds = restSeconds;
  if (notes !== undefined) updateData.notes = notes;

  if (Object.keys(updateData).length === 0) {
    return res.status(400).json({ error: '업데이트할 데이터가 없습니다' });
  }

  const updated = await prisma.routineExercise.update({
    where: { id: exerciseId },
    data: updateData,
    include: { equipment: true }
  });

  res.json({
    message: '운동이 업데이트되었습니다',
    exercise: {
      id: updated.id,
      order: updated.order,
      targetSets: updated.targetSets,
      targetReps: updated.targetReps,
      restSeconds: updated.restSeconds,
      notes: updated.notes,
      equipment: updated.equipment
    }
  });
}));

// DELETE /api/routines/:id
router.delete('/:id', auth(), asyncRoute(async (req, res) => {
  const routineId = parseInt(req.params.id, 10);
  const routine = await prisma.workoutRoutine.findFirst({ where: { id: routineId, userId: req.user.id } });
  if (!routine) return res.status(404).json({ error: '루틴을 찾을 수 없습니다' });
  await prisma.workoutRoutine.delete({ where: { id: routineId } });
  res.status(204).end();
}));

// POST /api/routines/:routineId/exercises/:exerciseId/start
router.post('/:routineId/exercises/:exerciseId/start', auth(), asyncRoute(async (req, res) => {
  const { routineId, exerciseId } = req.params;
  const { totalSets, restSeconds } = req.body;

  const exercise = await prisma.routineExercise.findFirst({
    where: { id: parseInt(exerciseId, 10), routineId: parseInt(routineId, 10), routine: { userId: req.user.id } },
    include: { equipment: true, routine: true },
  });
  if (!exercise) return res.status(404).json({ error: '운동 항목을 찾을 수 없습니다' });

  const equipmentId = exercise.equipmentId;
  const sets = totalSets || exercise.targetSets;
  const restSec = restSeconds ?? exercise.restSeconds;

  const currentUsage = await prisma.equipmentUsage.findFirst({ where: { equipmentId, status: 'IN_USE' } });
  if (currentUsage && currentUsage.userId !== req.user.id) {
    return res.status(409).json({ error: '기구가 사용 중입니다', message: '대기열에 등록하거나 나중에 다시 시도해주세요' });
  }

  const myUsage = await prisma.equipmentUsage.findFirst({ where: { userId: req.user.id, status: 'IN_USE' } });
  if (myUsage && myUsage.equipmentId !== equipmentId) {
    return res.status(409).json({ error: '이미 다른 기구를 사용 중입니다', currentEquipmentId: myUsage.equipmentId });
  }

  // 🔥 수정: estimatedEndAt 계산을 초 단위로 통일
  const workTimeSeconds = sets * 5 * 60; // 5분/세트
  const restTimeSeconds = (sets - 1) * restSec; // 세트간 휴식
  const totalDurationSeconds = workTimeSeconds + restTimeSeconds;

  const usage = await prisma.$transaction(async (tx) => {
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
        status: 'IN_USE',
        setStatus: 'EXERCISING',
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
    usageId: usage.id
  });
}));

// 🆕 PUT /api/routines/active-usage/rest-time - 진행중인 운동의 휴식시간 조정
router.put('/active-usage/rest-time', auth(), asyncRoute(async (req, res) => {
  const { adjustment } = req.body; // +10 또는 -10 (초)
  
  if (!adjustment || ![10, -10].includes(adjustment)) {
    return res.status(400).json({ error: '조정값은 +10 또는 -10이어야 합니다' });
  }

  const usage = await prisma.equipmentUsage.findFirst({
    where: { userId: req.user.id, status: 'IN_USE' },
    include: { equipment: true }
  });

  if (!usage) {
    return res.status(404).json({ error: '현재 사용 중인 기구가 없습니다' });
  }

  // 휴식 중이거나 다음 휴식을 위한 설정 변경
  const newRestSeconds = Math.max(0, usage.restSeconds + adjustment);
  
  const updated = await prisma.equipmentUsage.update({
    where: { id: usage.id },
    data: { restSeconds: newRestSeconds }
  });

  res.json({
    message: `휴식시간이 ${adjustment > 0 ? '증가' : '감소'}했습니다`,
    equipmentName: usage.equipment.name,
    previousRestSeconds: usage.restSeconds,
    newRestSeconds: newRestSeconds,
    adjustment: adjustment,
    currentSet: updated.currentSet,
    totalSets: updated.totalSets,
    setStatus: updated.setStatus
  });
}));

// 🆕 GET /api/routines/active-usage/status - 현재 사용중인 기구 상태
router.get('/active-usage/status', auth(), asyncRoute(async (req, res) => {
  const usage = await prisma.equipmentUsage.findFirst({
    where: { userId: req.user.id, status: 'IN_USE' },
    include: { equipment: true }
  });

  if (!usage) {
    return res.json({ active: false });
  }

  // 휴식 남은 시간 계산
  let restTimeLeft = 0;
  if (usage.setStatus === 'RESTING' && usage.restStartedAt) {
    const restElapsed = Date.now() - usage.restStartedAt.getTime();
    restTimeLeft = Math.max(0, Math.ceil((usage.restSeconds * 1000 - restElapsed) / 1000));
  }

  // 세트 진행률 계산
  const setProgress = usage.setStatus === 'EXERCISING' && usage.currentSetStartedAt 
    ? Math.min(100, Math.round((Date.now() - usage.currentSetStartedAt.getTime()) / (3 * 60 * 1000) * 100))
    : 0;

  res.json({
    active: true,
    usageId: usage.id,
    equipmentId: usage.equipmentId,
    equipmentName: usage.equipment.name,
    totalSets: usage.totalSets,
    currentSet: usage.currentSet,
    setStatus: usage.setStatus,
    restSeconds: usage.restSeconds, // 현재 설정된 휴식시간 (초)
    restTimeLeft: restTimeLeft, // 현재 휴식 남은시간 (초)
    progress: Math.round((usage.currentSet / usage.totalSets) * 100),
    setProgress: setProgress,
    startedAt: usage.startedAt,
    estimatedEndAt: usage.estimatedEndAt
  });
}));

module.exports = router;