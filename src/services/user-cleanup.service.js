const prisma = require("../lib/prisma");
const eventBus = require("../events/eventBus");

/**
 * @param {number} userId - 정리할 사용자 ID
 * @param {string} reason - 정리 사유 ('logout', 'account_deleted')
 * @returns {Promise<Object>} 정리 결과
 */
async function cleanupUserActivities(userId, reason = "logout") {
  const {
    notifyNextUser,
    stopAutoUpdate,
    clearWorkAcc,
    reorderQueue,
    computeStopSummary,
  } = require("./waiting.service");

  const result = {
    workoutStopped: false,
    equipmentName: null,
    queuesCancelled: 0,
    routinesDeactivated: 0,
  };

  try {
    // 1. 현재 진행 중인 운동 강제 종료
    const currentUsage = await prisma.equipmentUsage.findFirst({
      where: { userId, status: "IN_USE" },
      include: {
        equipment: true,
        user: { select: { name: true } },
      },
    });

    if (currentUsage) {
      const now = new Date();
      const stopSummary = computeStopSummary(currentUsage, now);

      await prisma.equipmentUsage.update({
        where: { id: currentUsage.id },
        data: {
          status: "COMPLETED",
          setStatus: "STOPPED",
          endedAt: now,
        },
      });

      // WebSocket 이벤트 발행
      eventBus.emitWorkoutCompletion(currentUsage.equipmentId, {
        type: "workout_stopped",
        equipmentName: currentUsage.equipment.name,
        userName: currentUsage.user.name,
        userId: userId,
        totalSets: currentUsage.totalSets,
        completedSets: currentUsage.currentSet,
        stoppedAt: now,
        durationSeconds: stopSummary.totalDurationSec,
        wasFullyCompleted: false,
        wasInterrupted: true,
        reason: reason,
        completionMessage:
          reason === "account_deleted"
            ? `${currentUsage.user.name}님이 계정을 탈퇴하여 ${currentUsage.equipment.name} 운동이 중단되었습니다`
            : `${currentUsage.user.name}님이 로그아웃하여 ${currentUsage.equipment.name} 운동이 중단되었습니다`,
      });

      // 자동 업데이트 중단 및 캐시 정리
      stopAutoUpdate(currentUsage.equipmentId);
      clearWorkAcc(currentUsage.id);

      // 다음 대기자에게 알림
      setTimeout(() => notifyNextUser(currentUsage.equipmentId), 1000);

      result.workoutStopped = true;
      result.equipmentName = currentUsage.equipment.name;
    }

    // 2. 모든 대기열에서 제거
    const activeQueues = await prisma.waitingQueue.findMany({
      where: {
        userId,
        status: { in: ["WAITING", "NOTIFIED"] },
      },
      include: {
        equipment: true,
        user: { select: { name: true } },
      },
    });

    if (activeQueues.length > 0) {
      await prisma.waitingQueue.updateMany({
        where: {
          userId,
          status: { in: ["WAITING", "NOTIFIED"] },
        },
        data: { status: "EXPIRED" },
      });

      // 각 기구의 대기열 재정렬 및 이벤트 발행
      for (const queue of activeQueues) {
        await reorderQueue(queue.equipmentId);

        eventBus.emitEquipmentStatusChange(queue.equipmentId, {
          type: "queue_cancelled",
          equipmentName: queue.equipment.name,
          cancelledBy: {
            userId: userId,
            userName: queue.user.name,
            reason: reason,
          },
          timestamp: new Date().toISOString(),
        });

        // 다음 대기자 알림
        if (queue.status === "NOTIFIED") {
          setTimeout(() => notifyNextUser(queue.equipmentId), 500);
        }
      }

      result.queuesCancelled = activeQueues.length;
    }

    // 3. 활성 루틴 비활성화
    const routinesResult = await prisma.workoutRoutine.updateMany({
      where: {
        userId,
        isActive: true,
      },
      data: {
        isActive: false,
        updatedAt: new Date(),
      },
    });

    result.routinesDeactivated = routinesResult.count;

    return result;
  } catch (error) {
    console.error(
      `사용자 작업 정리 실패 (userId: ${userId}, reason: ${reason}):`,
      error,
    );
    throw error;
  }
}

module.exports = {
  cleanupUserActivities,
};
