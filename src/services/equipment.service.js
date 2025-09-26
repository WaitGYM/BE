const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// 기구 상태, 내 대기/사용, 오늘 완료 내역, 최근 완료 정보까지 한 번에
async function getEquipmentStatusInfo(equipmentIds, userId = null) {
  const [currentUsages, waitingQueues] = await Promise.all([
    prisma.equipmentUsage.findMany({
      where: { equipmentId: { in: equipmentIds }, status: 'IN_USE' },
      include: { user: { select: { name: true } } },
    }),
    prisma.waitingQueue.findMany({
      where: { equipmentId: { in: equipmentIds }, status: { in: ['WAITING', 'NOTIFIED'] } },
      orderBy: { queuePosition: 'asc' },
    }),
  ]);

  let myQueues = [];
  let myCurrentUsage = null;
  let myCompletedToday = new Map();
  let recentCompletions = new Map(); // 🆕 최근 완료 정보

  if (userId) {
    [myQueues, myCurrentUsage] = await Promise.all([
      prisma.waitingQueue.findMany({
        where: { userId, equipmentId: { in: equipmentIds }, status: { in: ['WAITING', 'NOTIFIED'] } },
      }),
      prisma.equipmentUsage.findFirst({ where: { userId, status: 'IN_USE' } }),
    ]);

    const today = new Date();
    const sod = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const completed = await prisma.equipmentUsage.findMany({
      where: { userId, equipmentId: { in: equipmentIds }, status: 'COMPLETED', endedAt: { gte: sod } },
      orderBy: { endedAt: 'desc' },
      include: { user: { select: { name: true } } },
    });

    completed.forEach((u) => {
      if (!myCompletedToday.has(u.equipmentId)) {
        const duration = u.startedAt && u.endedAt ? Math.round((u.endedAt - u.startedAt) / 1000) : null;
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

    // 🆕 최근 10분 이내 완료된 운동 조회 (다른 사용자들도 포함)
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const recentCompletedUsages = await prisma.equipmentUsage.findMany({
      where: { 
        equipmentId: { in: equipmentIds }, 
        status: 'COMPLETED', 
        endedAt: { gte: tenMinutesAgo } 
      },
      include: { user: { select: { name: true } } },
      orderBy: { endedAt: 'desc' },
    });

    recentCompletedUsages.forEach((u) => {
      const existing = recentCompletions.get(u.equipmentId);
      if (!existing || u.endedAt > existing.endedAt) {
        const duration = u.startedAt && u.endedAt ? Math.round((u.endedAt - u.startedAt) / 1000) : null;
        recentCompletions.set(u.equipmentId, {
          userName: u.user.name,
          isMe: u.userId === userId,
          completedAt: u.endedAt,
          totalSets: u.totalSets,
          completedSets: u.currentSet,
          setStatus: u.setStatus,
          durationSeconds: duration,
          wasFullyCompleted: u.setStatus === 'COMPLETED',
          wasInterrupted: ['STOPPED', 'FORCE_COMPLETED'].includes(u.setStatus),
        });
      }
    });
  }

  const statusMap = new Map();
  equipmentIds.forEach((id) => {
    const cu = currentUsages.find((u) => u.equipmentId === id);
    const queueCount = waitingQueues.filter((q) => q.equipmentId === id).length;
    const myQ = myQueues.find((q) => q.equipmentId === id);
    const isAvailable = !cu;
    const canStart = isAvailable && !myQ && (!myCurrentUsage || myCurrentUsage.equipmentId === id);
    const canQueue = !isAvailable && !myQ && (!myCurrentUsage || myCurrentUsage.equipmentId === id);

    const myCompleted = userId ? myCompletedToday.get(id) || null : null;
    const recentCompletion = userId ? recentCompletions.get(id) || null : null;

    // 🆕 기구 상태 결정 로직
    let equipmentStatus = 'available'; // available | in_use | recently_completed
    let statusMessage = '사용 가능';
    let statusColor = 'green';

    if (cu) {
      equipmentStatus = 'in_use';
      statusMessage = `${cu.user.name} 사용 중`;
      statusColor = 'orange';
    } else if (recentCompletion) {
      equipmentStatus = 'recently_completed';
      const minutesAgo = Math.round((Date.now() - recentCompletion.completedAt.getTime()) / 60000);
      if (recentCompletion.isMe) {
        statusMessage = `방금 완료 (${minutesAgo}분 전)`;
        statusColor = 'blue';
      } else {
        statusMessage = `${recentCompletion.userName} 완료 (${minutesAgo}분 전)`;
        statusColor = 'gray';
      }
    }

    statusMap.set(id, {
      // 기본 상태 정보
      isAvailable,
      equipmentStatus, // 🆕 추가
      statusMessage,   // 🆕 추가
      statusColor,     // 🆕 추가
      
      // 현재 사용자 정보
      currentUser: cu ? cu.user.name : null,
      currentUserStartedAt: cu ? cu.startedAt : null,
      currentUsageInfo: cu
        ? {
            totalSets: cu.totalSets,
            currentSet: cu.currentSet,
            setStatus: cu.setStatus,
            restSeconds: cu.restSeconds,
            progress: cu.totalSets > 0 ? Math.round((cu.currentSet / cu.totalSets) * 100) : 0,
            estimatedEndAt: cu.estimatedEndAt,
          }
        : null,

      // 대기열 정보
      waitingCount: queueCount,
      myQueuePosition: myQ ? myQ.queuePosition : null,
      myQueueStatus: myQ ? myQ.status : null,
      canStart: !!userId && canStart,
      canQueue: !!userId && canQueue,

      // 내 완료 기록 (오늘)
      completedToday: !!myCompleted,
      lastCompletedAt: myCompleted?.lastCompletedAt ?? null,
      lastCompletedSets: myCompleted?.completedSets ?? null,
      lastCompletedTotalSets: myCompleted?.totalSets ?? null,
      lastCompletedDurationSeconds: myCompleted?.durationSeconds ?? null,
      wasFullyCompleted: myCompleted?.setStatus === 'COMPLETED',

      // 🆕 최근 완료 정보 (10분 이내, 모든 사용자)
      recentCompletion: recentCompletion ? {
        userName: recentCompletion.userName,
        isMe: recentCompletion.isMe,
        completedAt: recentCompletion.completedAt,
        minutesAgo: Math.round((Date.now() - recentCompletion.completedAt.getTime()) / 60000),
        totalSets: recentCompletion.totalSets,
        completedSets: recentCompletion.completedSets,
        durationSeconds: recentCompletion.durationSeconds,
        wasFullyCompleted: recentCompletion.wasFullyCompleted,
        wasInterrupted: recentCompletion.wasInterrupted,
        completionRate: recentCompletion.totalSets > 0 
          ? Math.round((recentCompletion.completedSets / recentCompletion.totalSets) * 100) 
          : 0,
      } : null,
    });
  });

  return statusMap;
}

module.exports = { getEquipmentStatusInfo, prisma };