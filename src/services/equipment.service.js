//src/services/equipment.service.js
const prisma = require("../lib/prisma");
const {
  calculateRealTimeETA,
  buildQueueETAs,
  estimateIfJoinNow,
} = require("../utils/eta");

// 기구 상태, 내 대기/사용, 오늘 완료 내역, 최근 완료 정보까지 한 번에
async function getEquipmentStatusInfo(equipmentIds, userId = null) {
  const [currentUsages, waitingQueues] = await Promise.all([
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
  ]);

  let myQueues = [];
  let myCurrentUsage = null;
  let myCompletedToday = new Map();
  let recentCompletions = new Map();

  if (userId) {
    [myQueues, myCurrentUsage] = await Promise.all([
      prisma.waitingQueue.findMany({
        where: {
          userId,
          equipmentId: { in: equipmentIds },
          status: { in: ["WAITING", "NOTIFIED"] },
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      prisma.equipmentUsage.findFirst({ where: { userId, status: "IN_USE" } }),
    ]);

    const latestQueues = new Map();
    myQueues.forEach((q) => {
      const existing = latestQueues.get(q.equipmentId);
      if (!existing || q.createdAt > existing.createdAt) {
        latestQueues.set(q.equipmentId, q);
      }
    });
    myQueues = Array.from(latestQueues.values());

    const { rangeTodayKST } = require("../utils/time");
    const { start, end } = rangeTodayKST();

    const completed = await prisma.equipmentUsage.findMany({
      where: {
        userId,
        equipmentId: { in: equipmentIds },
        status: "COMPLETED",
        endedAt: { gte: start, lte: end },
      },
      orderBy: { endedAt: "desc" },
      include: { user: { select: { name: true } } },
    });

    completed.forEach((u) => {
      if (!myCompletedToday.has(u.equipmentId)) {
        const duration =
          u.startedAt && u.endedAt
            ? Math.round((u.endedAt - u.startedAt) / 1000)
            : null;
        myCompletedToday.set(u.equipmentId, {
          status: u.status,
          lastCompletedAt: u.endedAt,
          totalSets: u.totalSets,
          completedSets: u.currentSet,
          setStatus: u.setStatus,
          durationSeconds: duration,
        });
      }
    });

    // 최근 10분 이내 완료된 운동 조회 (다른 사용자들도 포함)
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const recentCompletedUsages = await prisma.equipmentUsage.findMany({
      where: {
        equipmentId: { in: equipmentIds },
        status: "COMPLETED",
        endedAt: { gte: tenMinutesAgo },
      },
      include: { user: { select: { name: true } } },
      orderBy: { endedAt: "desc" },
    });

    recentCompletedUsages.forEach((u) => {
      const existing = recentCompletions.get(u.equipmentId);
      if (!existing || u.endedAt > existing.endedAt) {
        const duration =
          u.startedAt && u.endedAt
            ? Math.round((u.endedAt - u.startedAt) / 1000)
            : null;
        recentCompletions.set(u.equipmentId, {
          userName: u.user.name,
          isMe: u.userId === userId,
          completedAt: u.endedAt,
          totalSets: u.totalSets,
          completedSets: u.currentSet,
          setStatus: u.setStatus,
          durationSeconds: duration,
          wasFullyCompleted: u.setStatus === "COMPLETED",
          wasInterrupted: ["STOPPED", "FORCE_COMPLETED"].includes(u.setStatus),
        });
      }
    });
  }

  const statusMap = new Map();

  equipmentIds.forEach((id) => {
    const cu = currentUsages.find((u) => u.equipmentId === id);
    const queue = waitingQueues.filter((q) => q.equipmentId === id);
    const queueCount = queue.length;
    const myQ = myQueues.find((q) => q.equipmentId === id);

    // 🔥 수정: 대기열이 있으면 사용 불가
    const isAvailable = !cu && queueCount === 0;

    const canStart =
      isAvailable &&
      !myQ &&
      (!myCurrentUsage || myCurrentUsage.equipmentId === id);
    const canQueue =
      !isAvailable &&
      !myQ &&
      (!myCurrentUsage || myCurrentUsage.equipmentId !== id);

    const myCompleted = userId ? myCompletedToday.get(id) || null : null;
    const recentCompletion = userId ? recentCompletions.get(id) || null : null;

    let currentUserETA = 0;
    let queueETAs = [];
    let myEstimatedWaitMinutes = null;

    if (cu) {
      currentUserETA = calculateRealTimeETA(cu);
      if (queue.length > 0) {
        queueETAs = buildQueueETAs(currentUserETA, queue);
        if (myQ) {
          const myIndex = queue.findIndex((q) => q.id === myQ.id);
          if (myIndex !== -1) {
            myEstimatedWaitMinutes = queueETAs[myIndex];
          }
        }
      }
    } else if (queue.length > 0) {
      // 🔥 수정: 기구는 비었지만 대기열이 있는 경우도 ETA 계산
      queueETAs = buildQueueETAs(0, queue);
      if (myQ && queue.length > 0) {
        const myIndex = queue.findIndex((q) => q.id === myQ.id);
        if (myIndex !== -1) {
          myEstimatedWaitMinutes = queueETAs[myIndex];
        }
      }
    }

    // 🔥 수정: 관찰자(대기 안한 사람)도 "지금 줄서면" 예상시간 제공
    if (myEstimatedWaitMinutes == null) {
      myEstimatedWaitMinutes = estimateIfJoinNow({
        isAvailable,
        waitingCount: queueCount,
        queueETAs,
        currentETA: currentUserETA,
      });
    }

    // 🔥 수정: 기구 상태 결정 로직
    let equipmentStatus = "available";
    let statusMessage = "사용 가능";
    let statusColor = "green";

    if (cu) {
      equipmentStatus = "in_use";
      statusMessage = `${cu.user.name} 사용 중`;
      statusColor = "orange";
    } else if (queueCount > 0) {
      // 🔥 추가: 기구는 비었지만 대기열이 있는 경우
      equipmentStatus = "waiting";
      statusMessage = `${queueCount}명 대기 중`;
      statusColor = "yellow";
    } else if (recentCompletion) {
      equipmentStatus = "recently_completed";
      const minutesAgo = Math.round(
        (Date.now() - recentCompletion.completedAt.getTime()) / 60000,
      );
      if (recentCompletion.isMe) {
        statusMessage = `방금 완료 (${minutesAgo}분 전)`;
        statusColor = "blue";
      } else {
        statusMessage = `${recentCompletion.userName} 완료 (${minutesAgo}분 전)`;
        statusColor = "gray";
      }
    }

    statusMap.set(id, {
      // 기본 상태 정보
      isAvailable,
      equipmentStatus,
      statusMessage,
      statusColor,

      // 현재 사용자 정보
      currentUser: cu ? cu.user.name : null,
      currentUserId: cu ? cu.userId : null,
      currentUserStartedAt: cu ? cu.startedAt : null,
      currentUsageInfo: cu
        ? {
            totalSets: cu.totalSets,
            currentSet: cu.currentSet,
            setStatus: cu.setStatus,
            restSeconds: cu.restSeconds,
            progress:
              cu.totalSets > 0
                ? Math.round((cu.currentSet / cu.totalSets) * 100)
                : 0,
            estimatedEndAt: cu.estimatedEndAt,
          }
        : null,

      // 대기열 정보
      waitingCount: queueCount,
      myQueuePosition: myQ ? myQ.queuePosition : null,
      myQueueStatus: myQ ? myQ.status : null,
      myQueueId: myQ ? myQ.id : null,
      canStart: !!userId && canStart,
      canQueue: !!userId && canQueue,

      isUsingOtherEquipment:
        !!myCurrentUsage && myCurrentUsage.equipmentId !== id,
      currentlyUsedEquipmentId: myCurrentUsage?.equipmentId || null,

      // ETA 정보
      currentUserETA,
      estimatedWaitMinutes: myEstimatedWaitMinutes,
      queueETAs,
      averageWaitTime:
        queueETAs.length > 0
          ? Math.round(queueETAs.reduce((a, b) => a + b, 0) / queueETAs.length)
          : 0,

      // 내 완료 기록
      completedToday: !!myCompleted,
      lastCompletedAt: myCompleted?.lastCompletedAt ?? null,
      lastCompletedSets: myCompleted?.completedSets ?? null,
      lastCompletedTotalSets: myCompleted?.totalSets ?? null,
      lastCompletedDurationSeconds: myCompleted?.durationSeconds ?? null,
      wasFullyCompleted: myCompleted?.setStatus === "COMPLETED",

      // 최근 완료 정보
      recentCompletion: recentCompletion
        ? {
            userName: recentCompletion.userName,
            isMe: recentCompletion.isMe,
            completedAt: recentCompletion.completedAt,
            minutesAgo: Math.round(
              (Date.now() - recentCompletion.completedAt.getTime()) / 60000,
            ),
            totalSets: recentCompletion.totalSets,
            completedSets: recentCompletion.completedSets,
            durationSeconds: recentCompletion.durationSeconds,
            wasFullyCompleted: recentCompletion.wasFullyCompleted,
            wasInterrupted: recentCompletion.wasInterrupted,
            completionRate:
              recentCompletion.totalSets > 0
                ? Math.round(
                    (recentCompletion.completedSets /
                      recentCompletion.totalSets) *
                      100,
                  )
                : 0,
          }
        : null,
    });
  });

  return statusMap;
}

module.exports = { getEquipmentStatusInfo };
