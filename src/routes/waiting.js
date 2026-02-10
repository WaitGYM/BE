const router = require("express").Router();
const { auth } = require("../middleware/auth");
const asyncRoute = require("../utils/asyncRoute");
const eventBus = require("../events/eventBus");
const {
  RATE_LIMIT,
  checkRateLimit,
  calculateRealTimeETA,
  buildQueueETAs,
  startAutoUpdate,
  stopAutoUpdate,
  reorderQueue,
  notifyNextUser,
  autoUpdateCount,
  userUpdateLimiter,
  initWorkAcc,
  clearWorkAcc,
  computeSummaryOnComplete,
  notifyCurrentUserWaitingCount,
  computeStopSummary,
  sendAndSaveNotification,
  getCurrentUsage,
  getUsageByEquipment,
} = require("../services/waiting.service");
const { authOptional } = require("../utils/authOptional");
const { getEquipmentStatusInfo } = require("../services/equipment.service");
const prisma = require("../lib/prisma");

// POST /api/waiting/queue/:equipmentId - 대기열 등록
router.post(
  "/queue/:equipmentId",
  auth(),
  asyncRoute(async (req, res) => {
    const equipmentId = parseInt(req.params.equipmentId, 10);
    const equipment = await prisma.equipment.findUnique({
      where: { id: equipmentId },
    });
    if (!equipment)
      return res.status(404).json({ error: "기구를 찾을 수 없습니다" });

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
        queuePosition: existingQueue.queuePosition,
        status: existingQueue.status,
      });
    }

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
      if (myUsage.setStatus === "RESTING") {
        console.log(
          `User ${req.user.id} queuing for equipment ${equipmentId} while resting on equipment ${myUsage.equipmentId}`
        );
      } else if (myUsage.setStatus === "EXERCISING") {
        console.log(
          `User ${req.user.id} queuing for equipment ${equipmentId} while exercising on equipment ${myUsage.equipmentId}`
        );
      }
    }

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
      include: { user: { select: { name: true } } },
    });

    const currentUsage = await prisma.equipmentUsage.findFirst({
      where: { equipmentId, status: "IN_USE" },
    });

    let estimatedWaitMinutes = 0;
    if (currentUsage) {
      const queueList = await prisma.waitingQueue.findMany({
        where: { equipmentId, status: { in: ["WAITING", "NOTIFIED"] } },
        orderBy: { queuePosition: "asc" },
      });
      const currentETA = calculateRealTimeETA(currentUsage);
      const etas = buildQueueETAs(currentETA, queueList);
      const idx = queueList.findIndex((q) => q.id === queue.id);
      estimatedWaitMinutes = etas[idx] ?? 0;
      startAutoUpdate(equipmentId);
    } else {
      if (queue.queuePosition === 1) {
      setTimeout(() => notifyNextUser(equipmentId), 300);
      }
    }

    // WebSocket 이벤트만 발행
    eventBus.emitEquipmentStatusChange(equipmentId, {
      type: "queue_joined",
      equipmentName: equipment.name,
      userName: queue.user.name,
      queuePosition: queue.queuePosition,
      queueId: queue.id,
    });

    await notifyCurrentUserWaitingCount(equipmentId);

    const response = {
      message: `${equipment.name} 대기열에 등록되었습니다`,
      equipmentName: equipment.name,
      queuePosition: queue.queuePosition,
      queueId: queue.id,
      estimatedWaitMinutes,
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
  })
);

// POST /api/waiting/update-eta/:equipmentId
router.post(
  "/update-eta/:equipmentId",
  auth(),
  asyncRoute(async (req, res) => {
    const equipmentId = parseInt(req.params.equipmentId, 10);
    const userId = req.user.id;

    const rl = checkRateLimit(userId);
    if (!rl.allowed) {
      const remainingSeconds = Math.ceil(rl.remainingMs / 1000);
      return res.status(429).json({
        error:
          rl.reason === "cooldown"
            ? "너무 자주 업데이트했습니다"
            : "업데이트 횟수 초과",
        remainingSeconds,
        message: `${remainingSeconds}초 후 다시 시도해주세요`,
      });
    }

    const equipment = await prisma.equipment.findUnique({
      where: { id: equipmentId },
    });
    if (!equipment)
      return res.status(404).json({ error: "기구를 찾을 수 없습니다" });

    const [currentUsage, queue] = await Promise.all([
      prisma.equipmentUsage.findFirst({
        where: { equipmentId, status: "IN_USE" },
        include: { user: { select: { name: true } } },
      }),
      prisma.waitingQueue.findMany({
        where: { equipmentId, status: { in: ["WAITING", "NOTIFIED"] } },
        orderBy: { queuePosition: "asc" },
        include: { user: { select: { name: true } } },
      }),
    ]);

    const currentETA = currentUsage ? calculateRealTimeETA(currentUsage) : 0;
    const queueETAs = buildQueueETAs(currentETA, queue);
    const updateTime = new Date();

    const updateData = {
      equipmentId,
      equipmentName: equipment.name,
      updatedAt: updateTime,
      updatedBy: userId,
      currentUsage: currentUsage
        ? {
            userName: currentUsage.user.name,
            totalSets: currentUsage.totalSets,
            currentSet: currentUsage.currentSet,
            setStatus: currentUsage.setStatus,
            estimatedMinutesLeft: currentETA,
            progress: Math.round(
              (currentUsage.currentSet / currentUsage.totalSets) * 100
            ),
          }
        : null,
      waitingQueue: queue.map((q, i) => ({
        id: q.id,
        position: q.queuePosition,
        userName: q.user.name,
        estimatedWaitMinutes: queueETAs[i],
        isYou: q.userId === userId,
      })),
      totalWaiting: queue.length,
      isManualUpdate: true,
    };

    // WebSocket 이벤트만 발행 (알림 저장 없음)
    eventBus.emitETAUpdate(equipmentId, updateData);

    res.json(updateData);
  })
);

// POST /api/waiting/start-using/:equipmentId
router.post(
  "/start-using/:equipmentId",
  auth(),
  asyncRoute(async (req, res) => {
    const equipmentId = parseInt(req.params.equipmentId, 10);

    const { totalSets = 3, restSeconds = 180 } = req.body;
    const equipment = await prisma.equipment.findUnique({
      where: { id: equipmentId },
    });
    if (!equipment) return res.status(404).json({ error: "기구 없음" });

    const currentUsage = await prisma.equipmentUsage.findFirst({
      where: { equipmentId, status: "IN_USE" },
      include: { user: true },
    });

    if (currentUsage) {
      return res.status(409).json({
        error: "이미 사용 중",
        currentUser: currentUsage.user.name,
        since: currentUsage.startedAt,
      });
    }

    const myUsage = await prisma.equipmentUsage.findFirst({
      where: { userId: req.user.id, status: "IN_USE" },
      include: { equipment: { select: { name: true } } },
    });

    if (myUsage) {
      if (myUsage.equipmentId === equipmentId) {
        return res.status(409).json({
          error: "현재 해당 기구를 사용 중입니다",
          currentEquipment: myUsage.equipment.name,
          equipmentId: myUsage.equipmentId,
        });
      }
      if (myUsage.setStatus === "EXERCISING") {
        return res.status(409).json({
          error: "운동 중에는 다른 기구 대기 등록이 불가합니다",
          currentEquipment: myUsage.equipment.name,
          equipmentId: myUsage.equipmentId,
        });
      }
    }

    const firstInQueue = await prisma.waitingQueue.findFirst({
      where: { equipmentId, status: { in: ["WAITING", "NOTIFIED"] } },
      orderBy: { queuePosition: "asc" },
    });

    if (firstInQueue && firstInQueue.userId !== req.user.id) {
      return res.status(403).json({
        error: "대기 순서가 아님",
        firstPosition: firstInQueue.queuePosition,
      });
    }

    const workTimeSeconds = totalSets * 5 * 60;
    const restTimeSeconds = (totalSets - 1) * restSeconds;
    const totalDurationSeconds = workTimeSeconds + restTimeSeconds;

    const usage = await prisma.$transaction(async (tx) => {
      const newUsage = await tx.equipmentUsage.create({
        data: {
          equipmentId,
          userId: req.user.id,
          totalSets,
          currentSet: 1,
          restSeconds,
          status: "IN_USE",
          setStatus: "EXERCISING",
          currentSetStartedAt: new Date(),
          estimatedEndAt: new Date(Date.now() + totalDurationSeconds * 1000),
        },
        include: { equipment: true, user: { select: { name: true } } },
      });

      if (firstInQueue && firstInQueue.userId === req.user.id) {
        await tx.waitingQueue.update({
          where: { id: firstInQueue.id },
          data: { status: "COMPLETED" },
        });
      }

      return newUsage;
    });

    // WebSocket 이벤트만 발행
    eventBus.emitEquipmentStatusChange(equipmentId, {
      type: "usage_started",
      equipmentName: equipment.name,
      userName: usage.user.name,
      totalSets: usage.totalSets,
      startedAt: usage.startedAt,
    });

    startAutoUpdate(equipmentId);
    initWorkAcc(usage.id, 0);
    await notifyCurrentUserWaitingCount(equipmentId);

    res.status(201).json({
      id: usage.id,
      equipmentId: usage.equipmentId,
      equipmentName: usage.equipment.name,
      totalSets: usage.totalSets,
      currentSet: usage.currentSet,
      setStatus: usage.setStatus,
      restSeconds: usage.restSeconds,
      startedAt: usage.startedAt,
      estimatedEndAt: usage.estimatedEndAt,
      progress: Math.round((usage.currentSet / usage.totalSets) * 100),
    });
  })
);

// POST /api/waiting/complete-set/:equipmentId
router.post(
  "/complete-set/:equipmentId",
  auth(),
  asyncRoute(async (req, res) => {
    const equipmentId = parseInt(req.params.equipmentId, 10);
    const usage = await prisma.equipmentUsage.findFirst({
      where: { equipmentId, userId: req.user.id, status: "IN_USE" },
      include: { equipment: true, user: { select: { name: true } } },
    });

    if (!usage) return res.status(404).json({ error: "사용 중 아님" });
    if (usage.setStatus !== "EXERCISING") {
      return res.status(400).json({
        error: "EXERCISING 상태가 아님",
        currentStatus: usage.setStatus,
      });
    }

    const { summary } = computeSummaryOnComplete(usage, new Date());
    const isLastSet = usage.currentSet >= usage.totalSets;

    if (isLastSet) {
      const completedUsage = await prisma.equipmentUsage.update({
        where: { id: usage.id },
        data: {
          status: "COMPLETED",
          setStatus: "COMPLETED",
          endedAt: new Date(),
        },
        include: { equipment: true, user: { select: { name: true } } },
      });

      // WebSocket 이벤트만 발행 (알림 저장 없음)
      eventBus.emitWorkoutCompletion(equipmentId, {
        type: "workout_completed",
        equipmentName: usage.equipment.name,
        userName: usage.user.name,
        userId: req.user.id,
        totalSets: usage.totalSets,
        completedSets: usage.currentSet,
        completedAt: completedUsage.endedAt,
        durationSeconds: Math.round(
          (completedUsage.endedAt - usage.startedAt) / 1000
        ),
        wasFullyCompleted: true,
        completionMessage: `🎉 ${usage.user.name}님이 ${usage.equipment.name} 운동을 완료했습니다!`,
      });

      clearWorkAcc(usage.id);
      stopAutoUpdate(equipmentId);
      setTimeout(() => notifyNextUser(equipmentId), 1000);

      return res.json({
        message: `전체 ${usage.totalSets}세트 완료!`,
        completed: true,
        summary,
      });
    }

    await prisma.equipmentUsage.update({
      where: { id: usage.id },
      data: { setStatus: "RESTING", restStartedAt: new Date() },
    });

    // WebSocket 이벤트만 발행 (알림 저장 없음)
    eventBus.emitEquipmentStatusChange(equipmentId, {
      type: "rest_started",
      equipmentName: usage.equipment.name,
      userName: usage.user.name,
      currentSet: usage.currentSet,
      totalSets: usage.totalSets,
      restSeconds: usage.restSeconds,
    });

    if (usage.restSeconds > 0) {
      setTimeout(async () => {
        const current = await prisma.equipmentUsage.findUnique({
          where: { id: usage.id },
          include: { equipment: true, user: { select: { name: true } } },
        });

        if (
          current &&
          current.setStatus === "RESTING" &&
          current.status === "IN_USE"
        ) {
          await prisma.equipmentUsage.update({
            where: { id: usage.id },
            data: {
              currentSet: current.currentSet + 1,
              setStatus: "EXERCISING",
              currentSetStartedAt: new Date(),
              restStartedAt: null,
            },
          });

          // WebSocket 이벤트만 발행 (알림 저장 없음)
          eventBus.emitEquipmentStatusChange(equipmentId, {
            type: "next_set_started",
            equipmentName: current.equipment.name,
            userName: current.user.name,
            currentSet: current.currentSet + 1,
            totalSets: current.totalSets,
          });
        }
      }, usage.restSeconds * 1000);
    }

    res.json({
      message: `${usage.currentSet}/${usage.totalSets} 세트 완료`,
      setStatus: "RESTING",
      restSeconds: usage.restSeconds,
      summary,
    });
  })
);

// POST /api/waiting/skip-rest/:equipmentId
router.post(
  "/skip-rest/:equipmentId",
  auth(),
  asyncRoute(async (req, res) => {
    const equipmentId = parseInt(req.params.equipmentId, 10);
    const usage = await prisma.equipmentUsage.findFirst({
      where: { equipmentId, userId: req.user.id, status: "IN_USE" },
      include: { equipment: true, user: { select: { name: true } } },
    });

    if (!usage)
      return res.status(404).json({ error: "현재 사용 중인 기구가 없습니다" });
    if (usage.setStatus !== "RESTING") {
      return res.status(400).json({
        error: "휴식 중이 아닙니다",
        currentStatus: usage.setStatus,
        message: "휴식 중일 때만 건너뛸 수 있습니다",
      });
    }

    const nextSet = usage.currentSet + 1;
    const isLastSet = nextSet > usage.totalSets;

    if (isLastSet) {
      const completedUsage = await prisma.equipmentUsage.update({
        where: { id: usage.id },
        data: {
          status: "COMPLETED",
          setStatus: "COMPLETED",
          endedAt: new Date(),
        },
        include: { equipment: true, user: { select: { name: true } } },
      });

      // WebSocket 이벤트만 발행 (알림 저장 없음)
      eventBus.emitWorkoutCompletion(equipmentId, {
        type: "workout_completed",
        equipmentName: usage.equipment.name,
        userName: usage.user.name,
        userId: req.user.id,
        totalSets: usage.totalSets,
        completedSets: usage.currentSet,
        completedAt: completedUsage.endedAt,
        durationSeconds: Math.round(
          (completedUsage.endedAt - usage.startedAt) / 1000
        ),
        wasFullyCompleted: true,
        wasSkipped: true,
        completionMessage: `🎉 ${usage.user.name}님이 ${usage.equipment.name} 운동을 완료했습니다!`,
      });

      stopAutoUpdate(equipmentId);
      setTimeout(() => notifyNextUser(equipmentId), 1000);

      return res.json({
        message: `전체 ${usage.totalSets}세트 완료!`,
        completed: true,
        skippedRest: true,
      });
    }

    await prisma.equipmentUsage.update({
      where: { id: usage.id },
      data: {
        currentSet: nextSet,
        setStatus: "EXERCISING",
        currentSetStartedAt: new Date(),
        restStartedAt: null,
      },
    });

    // WebSocket 이벤트만 발행 (알림 저장 없음)
    eventBus.emitEquipmentStatusChange(equipmentId, {
      type: "rest_skipped",
      equipmentName: usage.equipment.name,
      userName: usage.user.name,
      currentSet: nextSet,
      totalSets: usage.totalSets,
      skippedAt: new Date(),
    });

    res.json({
      message: `휴식을 건너뛰고 ${nextSet}/${usage.totalSets}세트를 시작합니다`,
      currentSet: nextSet,
      totalSets: usage.totalSets,
      setStatus: "EXERCISING",
      skippedRest: true,
      progress: Math.round((nextSet / usage.totalSets) * 100),
    });
  })
);

// POST /api/waiting/stop-exercise/:equipmentId
router.post(
  "/stop-exercise/:equipmentId",
  auth(),
  asyncRoute(async (req, res) => {
    const equipmentId = parseInt(req.params.equipmentId, 10);
    const usage = await prisma.equipmentUsage.findFirst({
      where: { equipmentId, userId: req.user.id, status: "IN_USE" },
      include: { equipment: true, user: { select: { name: true } } },
    });

    if (!usage) return res.status(404).json({ error: "사용 중 아님" });

    const now = new Date();
    const stopSummary = computeStopSummary(usage, now);

    const stoppedUsage = await prisma.equipmentUsage.update({
      where: { id: usage.id },
      data: { status: "COMPLETED", setStatus: "STOPPED", endedAt: now },
      include: { equipment: true, user: { select: { name: true } } },
    });

    // WebSocket 이벤트만 발행 (알림 저장 없음)
    eventBus.emitWorkoutCompletion(equipmentId, {
      type: "workout_stopped",
      equipmentName: usage.equipment.name,
      userName: usage.user.name,
      userId: req.user.id,
      totalSets: usage.totalSets,
      completedSets: usage.currentSet,
      stoppedAt: stoppedUsage.endedAt,
      durationSeconds: stopSummary.totalDurationSec,
      workTimeSec: stopSummary.workTimeSec,
      restTimeSec: stopSummary.restTimeSec,
      workTime: stopSummary.workTime,
      restTime: stopSummary.restTime,
      totalDuration: stopSummary.totalDuration,
      wasFullyCompleted: false,
      wasInterrupted: true,
      completionMessage: `${usage.user.name}님이 ${usage.equipment.name} 운동을 중단했습니다`,
    });

    stopAutoUpdate(equipmentId);
    clearWorkAcc(usage.id);
    setTimeout(() => notifyNextUser(equipmentId), 1000);

    res.json({
      message: "운동 중단 완료",
      summary: stopSummary,
    });
  })
);

// GET /api/waiting/status/:equipmentId
router.get(
  "/status/:equipmentId",
  asyncRoute(async (req, res) => {
    const equipmentId = parseInt(req.params.equipmentId, 10);
    const equipment = await prisma.equipment.findUnique({
      where: { id: equipmentId },
    });
    if (!equipment)
      return res.status(404).json({ error: "기구를 찾을 수 없습니다" });

    const { userId } = authOptional(req);
    const statusMap = await getEquipmentStatusInfo([equipmentId], userId);
    const computed = statusMap.get(equipmentId) || {};

    const baseStatus = {
      isAvailable: true,
      currentUser: null,
      currentUserId: null,
      currentUserStartedAt: null,
      currentUsageInfo: null,
      waitingCount: 0,
      myQueuePosition: null,
      myQueueStatus: null,
      myQueueId: null,
      canStart: false,
      canQueue: false,
      currentUserETA: 0,
      estimatedWaitMinutes: 0,
      queueETAs: [],
      averageWaitTime: 0,
      completedToday: false,
      lastCompletedAt: null,
      lastCompletedSets: null,
      lastCompletedTotalSets: null,
      lastCompletedDurationSeconds: null,
      wasFullyCompleted: false,
      recentCompletion: null,
      equipmentStatus: "available",
      statusMessage: "사용 가능",
      statusColor: "green",
    };

    const status = { ...baseStatus, ...computed };

    res.json({
      equipmentId,
      equipmentName: equipment.name,
      status,
      updatedAt: new Date().toISOString(),
    });
  })
);

// DELETE /api/waiting/queue/:queueId
router.delete(
  "/queue/:queueId",
  auth(),
  asyncRoute(async (req, res) => {
    const queueId = parseInt(req.params.queueId, 10);
    if (!queueId || isNaN(queueId)) {
      return res.status(400).json({ error: "유효한 queueId가 필요합니다" });
    }

    const q = await prisma.waitingQueue.findUnique({
      where: { id: queueId },
      include: {
        equipment: { select: { id: true, name: true } },
        user: { select: { id: true, name: true } },
      },
    });

    if (!q) {
      return res.status(404).json({ error: "대기열 항목을 찾을 수 없습니다" });
    }

    if (q.userId !== req.user.id) {
      return res
        .status(403)
        .json({ error: "본인의 대기열만 취소할 수 있습니다" });
    }

    if (!["WAITING", "NOTIFIED"].includes(q.status)) {
      return res.status(409).json({
        error: "취소할 수 없는 상태입니다",
        status: q.status,
        message:
          q.status === "COMPLETED"
            ? "이미 완료된 대기열입니다"
            : q.status === "EXPIRED"
              ? "이미 만료된 대기열입니다"
              : `현재 상태(${q.status})에서는 취소할 수 없습니다`,
      });
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        await tx.waitingQueue.update({
          where: { id: queueId },
          data: { status: "EXPIRED" },
        });

        const remainingQueues = await tx.waitingQueue.findMany({
          where: {
            equipmentId: q.equipmentId,
            status: { in: ["WAITING", "NOTIFIED"] },
            id: { not: queueId },
          },
          orderBy: { createdAt: "asc" },
        });

        for (let i = 0; i < remainingQueues.length; i++) {
          if (remainingQueues[i].queuePosition !== i + 1) {
            await tx.waitingQueue.update({
              where: { id: remainingQueues[i].id },
              data: { queuePosition: i + 1 },
            });
          }
        }

        return {
          cancelledQueue: q,
          remainingCount: remainingQueues.length,
          wasNotified: q.status === "NOTIFIED",
        };
      });

      if (result.wasNotified) {
        setTimeout(() => notifyNextUser(q.equipmentId), 500);
      }

      // WebSocket 이벤트만 발행 (알림 저장 없음)
      eventBus.emitEquipmentStatusChange(q.equipmentId, {
        type: "queue_cancelled",
        equipmentName: q.equipment.name,
        cancelledBy: {
          userId: req.user.id,
          userName: q.user.name,
          isOwner: true,
        },
        cancelledQueueId: q.id,
        previousStatus: q.status,
        remainingWaiting: result.remainingCount,
        timestamp: new Date().toISOString(),
      });

      await notifyCurrentUserWaitingCount(q.equipmentId, { sendZero: false });

      res.status(200).json({
        success: true,
        message: "대기열이 성공적으로 취소되었습니다",
        cancelled: {
          queueId: q.id,
          equipmentId: q.equipmentId,
          equipmentName: q.equipment.name,
          previousPosition: q.queuePosition,
          previousStatus: q.status,
          cancelledAt: new Date().toISOString(),
        },
        remaining: {
          waitingCount: result.remainingCount,
          nextUserNotified: result.wasNotified,
        },
      });
    } catch (error) {
      console.error("대기열 취소 오류:", error);
      if (error.code === "P2025") {
        return res.status(404).json({
          error: "대기열을 찾을 수 없습니다",
          message: "이미 삭제되었거나 존재하지 않는 대기열입니다",
        });
      }
      if (error.code === "P2034") {
        return res.status(409).json({
          error: "동시성 충돌이 발생했습니다",
          message: "다시 시도해주세요",
        });
      }
      return res.status(500).json({
        error: "대기열 취소 중 오류가 발생했습니다",
        message: "서버 오류입니다. 잠시 후 다시 시도해주세요",
      });
    }
  })
);

// GET /api/waiting/my-queues - 내 모든 대기열 조회
router.get(
  "/my-queues",
  auth(),
  asyncRoute(async (req, res) => {
    const { status } = req.query;
    const where = { userId: req.user.id };

    if (status) {
      where.status = status.includes(",") ? { in: status.split(",") } : status;
    }

    const myQueues = await prisma.waitingQueue.findMany({
      where,
      include: {
        equipment: {
          select: { id: true, name: true, category: true, imageUrl: true },
        },
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    });

    const response = myQueues.map((q) => ({
      id: q.id,
      equipmentId: q.equipmentId,
      equipment: q.equipment,
      queuePosition: q.queuePosition,
      status: q.status,
      createdAt: q.createdAt,
      notifiedAt: q.notifiedAt,
      canCancel: ["WAITING", "NOTIFIED"].includes(q.status),
      statusMessage:
        q.status === "WAITING"
          ? `${q.queuePosition}번째 대기 중`
          : q.status === "NOTIFIED"
            ? "사용 가능 알림됨"
            : q.status === "COMPLETED"
              ? "사용 완료"
              : q.status === "EXPIRED"
                ? "대기 취소/만료"
                : q.status,
    }));

    res.json({
      queues: response,
      summary: {
        total: myQueues.length,
        waiting: myQueues.filter((q) => q.status === "WAITING").length,
        notified: myQueues.filter((q) => q.status === "NOTIFIED").length,
        completed: myQueues.filter((q) => q.status === "COMPLETED").length,
        expired: myQueues.filter((q) => q.status === "EXPIRED").length,
      },
    });
  })
);

// GET /api/waiting/admin/stats
router.get(
  "/admin/stats",
  auth(),
  asyncRoute(async (_req, res) => {
    const [activeUsages, activeQueues] = await Promise.all([
      prisma.equipmentUsage.count({ where: { status: "IN_USE" } }),
      prisma.waitingQueue.count({
        where: { status: { in: ["WAITING", "NOTIFIED"] } },
      }),
    ]);

    res.json({
      activeUsages,
      activeQueues,
      autoUpdateCount: autoUpdateCount(),
      rateLimitedUsers: userUpdateLimiter.size,
      timestamp: new Date(),
      rateLimitPolicy: RATE_LIMIT,
    });
  })
);

// ==========================================
// equipmentId 불필요한 간소화 API들
// ==========================================

// POST /api/waiting/complete-set
router.post(
  "/complete-set",
  auth(),
  asyncRoute(async (req, res) => {
    const usage = await getCurrentUsage(req.user.id);
    if (!usage) {
      return res.status(404).json({
        error: "현재 사용 중인 기구가 없습니다",
        suggestion: "운동을 시작한 후 다시 시도해주세요",
      });
    }

    if (usage.setStatus !== "EXERCISING") {
      return res.status(400).json({
        error: "EXERCISING 상태가 아닙니다",
        currentStatus: usage.setStatus,
        equipmentName: usage.equipment.name,
      });
    }

    const equipmentId = usage.equipmentId;
    const { summary } = computeSummaryOnComplete(usage, new Date());
    const isLastSet = usage.currentSet >= usage.totalSets;

    if (isLastSet) {
      const completedUsage = await prisma.equipmentUsage.update({
        where: { id: usage.id },
        data: {
          status: "COMPLETED",
          setStatus: "COMPLETED",
          endedAt: new Date(),
        },
        include: { equipment: true, user: { select: { name: true } } },
      });

      eventBus.emitWorkoutCompletion(equipmentId, {
        type: "workout_completed",
        equipmentName: usage.equipment.name,
        userName: usage.user.name,
        userId: req.user.id,
        totalSets: usage.totalSets,
        completedSets: usage.currentSet,
        completedAt: completedUsage.endedAt,
        durationSeconds: Math.round(
          (completedUsage.endedAt - usage.startedAt) / 1000
        ),
        wasFullyCompleted: true,
        completionMessage: `🎉 ${usage.user.name}님이 ${usage.equipment.name} 운동을 완료했습니다!`,
      });

      clearWorkAcc(usage.id);
      stopAutoUpdate(equipmentId);
      setTimeout(() => notifyNextUser(equipmentId), 1000);

      return res.json({
        message: `전체 ${usage.totalSets}세트 완료!`,
        completed: true,
        equipmentName: usage.equipment.name,
        summary,
      });
    }

    await prisma.equipmentUsage.update({
      where: { id: usage.id },
      data: { setStatus: "RESTING", restStartedAt: new Date() },
    });

    eventBus.emitEquipmentStatusChange(equipmentId, {
      type: "rest_started",
      equipmentName: usage.equipment.name,
      userName: usage.user.name,
      currentSet: usage.currentSet,
      totalSets: usage.totalSets,
      restSeconds: usage.restSeconds,
    });

    if (usage.restSeconds > 0) {
      setTimeout(async () => {
        const current = await prisma.equipmentUsage.findUnique({
          where: { id: usage.id },
          include: { equipment: true, user: { select: { name: true } } },
        });

        if (
          current &&
          current.setStatus === "RESTING" &&
          current.status === "IN_USE"
        ) {
          await prisma.equipmentUsage.update({
            where: { id: usage.id },
            data: {
              currentSet: current.currentSet + 1,
              setStatus: "EXERCISING",
              currentSetStartedAt: new Date(),
              restStartedAt: null,
            },
          });

          eventBus.emitEquipmentStatusChange(equipmentId, {
            type: "next_set_started",
            equipmentName: current.equipment.name,
            userName: current.user.name,
            currentSet: current.currentSet + 1,
            totalSets: current.totalSets,
          });
        }
      }, usage.restSeconds * 1000);
    }

    res.json({
      message: `${usage.currentSet}/${usage.totalSets} 세트 완료`,
      setStatus: "RESTING",
      restSeconds: usage.restSeconds,
      equipmentName: usage.equipment.name,
      summary,
    });
  })
);

// POST /api/waiting/skip-rest
router.post(
  "/skip-rest",
  auth(),
  asyncRoute(async (req, res) => {
    const usage = await getCurrentUsage(req.user.id);
    if (!usage) {
      return res.status(404).json({
        error: "현재 사용 중인 기구가 없습니다",
        suggestion: "운동을 시작한 후 다시 시도해주세요",
      });
    }

    if (usage.setStatus !== "RESTING") {
      return res.status(400).json({
        error: "휴식 중이 아닙니다",
        currentStatus: usage.setStatus,
        equipmentName: usage.equipment.name,
        message: "휴식 중일 때만 건너뛸 수 있습니다",
      });
    }

    const equipmentId = usage.equipmentId;
    const nextSet = usage.currentSet + 1;
    const isLastSet = nextSet > usage.totalSets;

    if (isLastSet) {
      const completedUsage = await prisma.equipmentUsage.update({
        where: { id: usage.id },
        data: {
          status: "COMPLETED",
          setStatus: "COMPLETED",
          endedAt: new Date(),
        },
        include: { equipment: true, user: { select: { name: true } } },
      });

      eventBus.emitWorkoutCompletion(equipmentId, {
        type: "workout_completed",
        equipmentName: usage.equipment.name,
        userName: usage.user.name,
        userId: req.user.id,
        totalSets: usage.totalSets,
        completedSets: usage.currentSet,
        completedAt: completedUsage.endedAt,
        durationSeconds: Math.round(
          (completedUsage.endedAt - usage.startedAt) / 1000
        ),
        wasFullyCompleted: true,
        wasSkipped: true,
        completionMessage: `🎉 ${usage.user.name}님이 ${usage.equipment.name} 운동을 완료했습니다!`,
      });

      stopAutoUpdate(equipmentId);
      setTimeout(() => notifyNextUser(equipmentId), 1000);

      return res.json({
        message: `전체 ${usage.totalSets}세트 완료!`,
        completed: true,
        equipmentName: usage.equipment.name,
        skippedRest: true,
      });
    }

    await prisma.equipmentUsage.update({
      where: { id: usage.id },
      data: {
        currentSet: nextSet,
        setStatus: "EXERCISING",
        currentSetStartedAt: new Date(),
        restStartedAt: null,
      },
    });

    eventBus.emitEquipmentStatusChange(equipmentId, {
      type: "rest_skipped",
      equipmentName: usage.equipment.name,
      userName: usage.user.name,
      currentSet: nextSet,
      totalSets: usage.totalSets,
      skippedAt: new Date(),
    });

    res.json({
      message: `휴식을 건너뛰고 ${nextSet}/${usage.totalSets}세트를 시작합니다`,
      currentSet: nextSet,
      totalSets: usage.totalSets,
      setStatus: "EXERCISING",
      equipmentName: usage.equipment.name,
      skippedRest: true,
      progress: Math.round((nextSet / usage.totalSets) * 100),
    });
  })
);

// POST /api/waiting/stop-exercise
router.post(
  "/stop-exercise",
  auth(),
  asyncRoute(async (req, res) => {
    const usage = await getCurrentUsage(req.user.id);
    if (!usage) {
      return res.status(404).json({
        error: "현재 사용 중인 기구가 없습니다",
        suggestion: "운동을 시작한 후 다시 시도해주세요",
      });
    }

    const equipmentId = usage.equipmentId;
    const now = new Date();
    const stopSummary = computeStopSummary(usage, now);

    const stoppedUsage = await prisma.equipmentUsage.update({
      where: { id: usage.id },
      data: { status: "COMPLETED", setStatus: "STOPPED", endedAt: now },
      include: { equipment: true, user: { select: { name: true } } },
    });

    eventBus.emitWorkoutCompletion(equipmentId, {
      type: "workout_stopped",
      equipmentName: usage.equipment.name,
      userName: usage.user.name,
      userId: req.user.id,
      totalSets: usage.totalSets,
      completedSets: usage.currentSet,
      stoppedAt: stoppedUsage.endedAt,
      durationSeconds: stopSummary.totalDurationSec,
      workTimeSec: stopSummary.workTimeSec,
      restTimeSec: stopSummary.restTimeSec,
      workTime: stopSummary.workTime,
      restTime: stopSummary.restTime,
      totalDuration: stopSummary.totalDuration,
      wasFullyCompleted: false,
      wasInterrupted: true,
      completionMessage: `${usage.user.name}님이 ${usage.equipment.name} 운동을 중단했습니다`,
    });

    stopAutoUpdate(equipmentId);
    clearWorkAcc(usage.id);
    setTimeout(() => notifyNextUser(equipmentId), 1000);

    res.json({
      message: "운동 중단 완료",
      equipmentName: usage.equipment.name,
      summary: stopSummary,
    });
  })
);

// GET /api/waiting/current-usage
router.get(
  "/current-usage",
  auth(),
  asyncRoute(async (req, res) => {
    const usage = await getCurrentUsage(req.user.id);
    if (!usage) {
      return res.json({
        active: false,
        message: "현재 사용 중인 기구가 없습니다",
      });
    }

    let restTimeLeft = 0;
    if (usage.setStatus === "RESTING" && usage.restStartedAt) {
      const restElapsed = Date.now() - usage.restStartedAt.getTime();
      restTimeLeft = Math.max(
        0,
        Math.ceil((usage.restSeconds * 1000 - restElapsed) / 1000)
      );
    }

    const setProgress =
      usage.setStatus === "EXERCISING" && usage.currentSetStartedAt
        ? Math.min(
            100,
            Math.round(
              ((Date.now() - usage.currentSetStartedAt.getTime()) /
                (3 * 60 * 1000)) *
                100
            )
          )
        : 0;

    res.json({
      active: true,
      usageId: usage.id,
      equipmentId: usage.equipmentId,
      equipmentName: usage.equipment.name,
      equipmentCategory: usage.equipment.category,
      equipmentImageUrl: usage.equipment.imageUrl,
      totalSets: usage.totalSets,
      currentSet: usage.currentSet,
      setStatus: usage.setStatus,
      restSeconds: usage.restSeconds,
      restTimeLeft: restTimeLeft,
      progress: Math.round((usage.currentSet / usage.totalSets) * 100),
      setProgress: setProgress,
      startedAt: usage.startedAt,
      estimatedEndAt: usage.estimatedEndAt,
    });
  })
);

module.exports = { router };
