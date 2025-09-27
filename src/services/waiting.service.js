const prisma = require('../lib/prisma');
const { sendNotification, broadcastETAUpdate, broadcastEquipmentStatusChange } = require('../websocket');
const { calculateRealTimeETA, buildQueueETAs } = require('../utils/eta');
const { computeCompleteSetSummary } = require('../utils/time');

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

 // ===== Workout Accumulator (메모리 캐시) =====
 //  - usageId별 '누적 운동시간(초)'을 보관
 //  - 스키마/엔드포인트 변경 없이 complete-set 응답에 총 소요/총 휴식 제공
 const WORK_ACC_CACHE = new Map(); // usageId -> number
 
 function initWorkAcc(usageId, initial = 0) {
   WORK_ACC_CACHE.set(usageId, Math.max(0, Number(initial) || 0));
 }
 
 function clearWorkAcc(usageId) {
   WORK_ACC_CACHE.delete(usageId);
 }
 
 /**
  * complete-set 직전에 호출해 요약 계산 + 누적 갱신
  * @param {Object} usage - equipmentUsage 레코드(startedAt,currentSetStartedAt,currentSet 필수)
  * @param {Date}   [now=new Date()]
  * @returns {{summary:Object, workAccSec:number}}
  */
 function computeSummaryOnComplete(usage, now = new Date()) {
   const prev = WORK_ACC_CACHE.get(usage.id) || 0;
   const { summary, workAccSec } = computeCompleteSetSummary({
     startedAt: usage.startedAt,
     currentSetStartedAt: usage.currentSetStartedAt,
     currentSet: usage.currentSet,
     workAccPrevSec: prev,
     now,
   });
   WORK_ACC_CACHE.set(usage.id, workAccSec);
   return { summary, workAccSec };
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

  const userCurrentUsage = await prisma.equipmentUsage.findFirst({
  where: { userId: next.userId, status: 'IN_USE' },
  include: { equipment: true }
});

await prisma.waitingQueue.update({ 
  where: { id: next.id }, 
  data: { status: 'NOTIFIED', notifiedAt: new Date() } 
});

// 알림 메시지에 현재 상황 반영
let notificationMessage = `${next.equipment.name}을 사용할 차례입니다`;
let additionalInfo = {};

if (userCurrentUsage) {
  if (userCurrentUsage.setStatus === 'RESTING') {
    notificationMessage = `${next.equipment.name} 사용 차례입니다. (현재 ${userCurrentUsage.equipment.name} 휴식 중)`;
    additionalInfo.currentEquipmentStatus = {
      equipmentName: userCurrentUsage.equipment.name,
      status: 'resting',
      message: '휴식을 마치고 기구를 전환하세요'
    };
  } else if (userCurrentUsage.setStatus === 'EXERCISING') {
    notificationMessage = `${next.equipment.name} 사용 차례입니다. (현재 ${userCurrentUsage.equipment.name} 운동 중)`;
    additionalInfo.currentEquipmentStatus = {
      equipmentName: userCurrentUsage.equipment.name,
      status: 'exercising',
      message: '현재 운동을 완료한 후 기구를 전환하세요',
      warning: '두 기구를 동시에 사용할 수 없습니다'
    };
  }
}

sendNotification(next.userId, {
  type: 'EQUIPMENT_AVAILABLE',
  title: '기구 사용 가능',
  message: notificationMessage,
  equipmentId, 
  equipmentName: next.equipment.name, 
  queueId: next.id, 
  graceMinutes: 5,
  ...additionalInfo
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
  initWorkAcc, clearWorkAcc, computeSummaryOnComplete,
};
