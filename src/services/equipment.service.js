const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// 기구 상태, 내 대기/사용, 오늘 완료 내역까지 한 번에
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
    });

    completed.forEach((u) => {
      if (!myCompletedToday.has(u.equipmentId)) {
        const duration = u.startedAt && u.endedAt ? Math.round((u.endedAt - u.startedAt) / 60000) : null;
        myCompletedToday.set(u.equipmentId, {
          status: u.status,
          lastCompletedAt: u.endedAt,
          totalSets: u.totalSets,
          setStatus: u.setStatus,
          duration,
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

    statusMap.set(id, {
      isAvailable,
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
      waitingCount: queueCount,
      myQueuePosition: myQ ? myQ.queuePosition : null,
      myQueueStatus: myQ ? myQ.status : null,
      canStart: !!userId && canStart,
      canQueue: !!userId && canQueue,

      completedToday: !!myCompleted,
      lastCompletedAt: myCompleted?.lastCompletedAt ?? null,
      lastCompletedSets: myCompleted?.totalSets ?? null,
      lastCompletedDuration: myCompleted?.duration ?? null,
      wasFullyCompleted: myCompleted?.status === 'COMPLETED',
    });
  });

  return statusMap;
}

module.exports = { getEquipmentStatusInfo, prisma };
