const { prisma } = require('./equipment.service');
const { sendNotification, broadcastETAUpdate, broadcastEquipmentStatusChange } = require('../websocket');

const AVG_SET_MIN = 3;            // 세트 평균(분)
const SETUP_CLEANUP_MIN = 1;      // 세팅/정리(분)

// ===== Rate Limit =====
const userUpdateLimiter = new Map();
const RATE_LIMIT = { WINDOW_MS: 60_000, MAX_REQUESTS: 3, COOLDOWN_MS: 10_000 };

function checkRateLimit(userId) {
  const now = Date.now();
  const rec = userUpdateLimiter.get(userId);
  if (!rec) { userUpdateLimiter.set(userId, { lastUpdate: now, requestCount: 1 }); return { allowed: true }; }
  if (now - rec.lastUpdate > RATE_LIMIT.WINDOW_MS) { userUpdateLimiter.set(userId, { lastUpdate: now, requestCount: 1 }); return { allowed: true }; }
  if (now - rec.lastUpdate < RATE_LIMIT.COOLDOWN_MS) return { allowed: false, remainingMs: RATE_LIMIT.COOLDOWN_MS - (now - rec.lastUpdate), reason: 'cooldown' };
  if (rec.requestCount >= RATE_LIMIT.MAX_REQUESTS) return { allowed: false, remainingMs: RATE_LIMIT.WINDOW_MS - (now - rec.lastUpdate), reason: 'rate_limit' };
  rec.requestCount++; rec.lastUpdate = now; return { allowed: true };
}

// ===== ETA =====
function calculateRealTimeETA(usage) {
  if (!usage || usage.status !== 'IN_USE') return 0;
  const now = Date.now();
  const setMs = AVG_SET_MIN * 60 * 1000;
  const restMs = (usage.restSeconds || 0) * 1000;
  const remainingSets = Math.max(0, usage.totalSets - usage.currentSet + 1);

  if (usage.setStatus === 'EXERCISING') {
    const elapsed = usage.currentSetStartedAt ? now - usage.currentSetStartedAt.getTime() : 0;
    const currRemain = Math.max(0, setMs - elapsed);
    const futureWork = (remainingSets - 1) * setMs;
    const futureRest = (remainingSets - 1) * restMs;
    return Math.ceil((currRemain + futureWork + futureRest) / 60000);
  }
  if (usage.setStatus === 'RESTING') {
    const restElapsed = usage.restStartedAt ? now - usage.restStartedAt.getTime() : 0;
    const restRemain = Math.max(0, restMs - restElapsed);
    const futureWork = remainingSets * setMs;
    const futureRest = (remainingSets - 1) * restMs;
    return Math.ceil((restRemain + futureWork + futureRest) / 60000);
  }
  return 0;
}

function buildQueueETAs(currentETA, queue) {
  const etas = [];
  let acc = currentETA + SETUP_CLEANUP_MIN;
  for (let i = 0; i < queue.length; i++) {
    etas.push(acc);
    acc += AVG_SET_MIN * 3 + 2 + SETUP_CLEANUP_MIN; // 경험치 기반 보수 추정
  }
  return etas;
}

// ===== Auto Update Registry =====
const autoUpdateIntervals = new Map();

async function startAutoUpdate(equipmentId) {
  if (autoUpdateIntervals.has(equipmentId)) return;

  const id = setInterval(async () => {
    try {
      const currentUsage = await prisma.equipmentUsage.findFirst({
        where: { equipmentId, status: 'IN_USE' },
        include: { user: { select: { name: true } }, equipment: true },
      });
      if (!currentUsage) return stopAutoUpdate(equipmentId);

      const queue = await prisma.waitingQueue.findMany({
        where: { equipmentId, status: { in: ['WAITING', 'NOTIFIED'] } },
        orderBy: { queuePosition: 'asc' },
        include: { user: { select: { name: true } } },
      });
      if (queue.length === 0) return stopAutoUpdate(equipmentId);

      const currentETA = calculateRealTimeETA(currentUsage);
      const queueETAs = buildQueueETAs(currentETA, queue);

      broadcastETAUpdate(equipmentId, {
        equipmentId,
        equipmentName: currentUsage.equipment.name,
        currentUsage: {
          userName: currentUsage.user.name,
          totalSets: currentUsage.totalSets,
          currentSet: currentUsage.currentSet,
          setStatus: currentUsage.setStatus,
          estimatedMinutesLeft: currentETA,
          progress: Math.round((currentUsage.currentSet / currentUsage.totalSets) * 100),
        },
        waitingQueue: queue.map((q, i) => ({
          id: q.id, position: q.queuePosition, userName: q.user.name, estimatedWaitMinutes: queueETAs[i],
        })),
        lastUpdated: new Date(),
        isAutoUpdate: true,
      });

      queue.forEach((q, i) => sendNotification(q.userId, {
        type: 'AUTO_ETA_UPDATE',
        title: 'ETA 자동 업데이트',
        message: `${currentUsage.equipment.name} 예상 대기시간: ${queueETAs[i]}분`,
        equipmentId,
        estimatedWaitMinutes: queueETAs[i],
        queuePosition: q.queuePosition,
      }));
    } catch (e) {
      console.error('자동 ETA 업데이트 오류:', e);
      stopAutoUpdate(equipmentId);
    }
  }, 2 * 60 * 1000);

  autoUpdateIntervals.set(equipmentId, id);
}

function stopAutoUpdate(equipmentId) {
  const id = autoUpdateIntervals.get(equipmentId);
  if (id) { clearInterval(id); autoUpdateIntervals.delete(equipmentId); }
}

// ===== Queue Utils =====
async function reorderQueue(equipmentId) {
  const rows = await prisma.waitingQueue.findMany({
    where: { equipmentId, status: { in: ['WAITING', 'NOTIFIED'] } },
    orderBy: { createdAt: 'asc' },
  });
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].queuePosition !== i + 1) {
      await prisma.waitingQueue.update({ where: { id: rows[i].id }, data: { queuePosition: i + 1 } });
    }
  }
  return rows.length;
}

async function notifyNextUser(equipmentId) {
  const next = await prisma.waitingQueue.findFirst({
    where: { equipmentId, status: 'WAITING' },
    orderBy: { queuePosition: 'asc' },
    include: { user: true, equipment: true },
  });
  if (!next) return false;

  await prisma.waitingQueue.update({ where: { id: next.id }, data: { status: 'NOTIFIED', notifiedAt: new Date() } });

  sendNotification(next.userId, {
    type: 'EQUIPMENT_AVAILABLE',
    title: '기구 사용 가능',
    message: `${next.equipment.name}을 사용할 차례입니다`,
    equipmentId, equipmentName: next.equipment.name, queueId: next.id, graceMinutes: 5,
  });

  broadcastEquipmentStatusChange(equipmentId, {
    type: 'next_user_notified', equipmentName: next.equipment.name, nextUserName: next.user.name, queuePosition: next.queuePosition,
  });

  setTimeout(async () => {
    const fresh = await prisma.waitingQueue.findUnique({ where: { id: next.id } });
    if (fresh && fresh.status === 'NOTIFIED') {
      await prisma.waitingQueue.update({ where: { id: next.id }, data: { status: 'EXPIRED' } });
      sendNotification(next.userId, { type: 'QUEUE_EXPIRED', title: '대기 만료', message: '시간 초과로 대기에서 제외되었습니다', equipmentId });
      await reorderQueue(equipmentId);
      await notifyNextUser(equipmentId);
    }
  }, 5 * 60 * 1000);

  return true;
}

module.exports = {
  RATE_LIMIT, checkRateLimit,
  calculateRealTimeETA, buildQueueETAs,
  startAutoUpdate, stopAutoUpdate,
  reorderQueue, notifyNextUser,
  autoUpdateCount: () => autoUpdateIntervals.size,
  userUpdateLimiter,
};
