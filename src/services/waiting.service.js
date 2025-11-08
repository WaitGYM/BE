// src/services/waiting.service.js
const prisma = require('../lib/prisma');
const eventBus = require('../events/eventBus');
const { calculateRealTimeETA, buildQueueETAs } = require('../utils/eta');
const { computeCompleteSetSummary, hms } = require('../utils/time');
const { saveNotification } = require('./notification.service');

// 스팸 방지를 위한 메모리 캐시: 장비별 최근 전송 상태
const lastWaitNotice = new Map(); // key: equipmentId, value: { count, ts }

const AVG_SET_MIN = 3; // 세트 평균(분)
const SETUP_CLEANUP_MIN = 1; // 세팅/정리(분)

// ===== Rate Limit =====
const userUpdateLimiter = new Map();
const RATE_LIMIT = { WINDOW_MS: 60_000, MAX_REQUESTS: 3, COOLDOWN_MS: 10_000 };

function checkRateLimit(userId) {
  const now = Date.now();
  const rec = userUpdateLimiter.get(userId);
  if (!rec) {
    userUpdateLimiter.set(userId, { lastUpdate: now, requestCount: 1 });
    return { allowed: true };
  }
  if (now - rec.lastUpdate > RATE_LIMIT.WINDOW_MS) {
    userUpdateLimiter.set(userId, { lastUpdate: now, requestCount: 1 });
    return { allowed: true };
  }
  if (now - rec.lastUpdate < RATE_LIMIT.COOLDOWN_MS) {
    return {
      allowed: false,
      remainingMs: RATE_LIMIT.COOLDOWN_MS - (now - rec.lastUpdate),
      reason: 'cooldown'
    };
  }
  if (rec.requestCount >= RATE_LIMIT.MAX_REQUESTS) {
    return {
      allowed: false,
      remainingMs: RATE_LIMIT.WINDOW_MS - (now - rec.lastUpdate),
      reason: 'rate_limit'
    };
  }
  rec.requestCount++;
  rec.lastUpdate = now;
  return { allowed: true };
}

// ===== Workout Accumulator (메모리 캐시) =====
const WORK_ACC_CACHE = new Map(); // usageId -> number

function initWorkAcc(usageId, initial = 0) {
  WORK_ACC_CACHE.set(usageId, Math.max(0, Number(initial) || 0));
}

function clearWorkAcc(usageId) {
  WORK_ACC_CACHE.delete(usageId);
}

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

function computeStopSummary(usage, now = new Date()) {
  const accWork = Math.max(0, Number(WORK_ACC_CACHE.get(usage.id) || 0));
  const startedAt = usage.startedAt ? new Date(usage.startedAt) : null;
  const totalDurationSec = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  
  let inFlightWorkSec = 0;
  if (usage.setStatus === 'EXERCISING' && usage.currentSetStartedAt) {
    inFlightWorkSec = Math.max(0, Math.floor((now - new Date(usage.currentSetStartedAt)) / 1000));
  }
  
  const workTimeSec = accWork + inFlightWorkSec;
  const restTimeSec = Math.max(0, totalDurationSec - workTimeSec);
  
  return {
    workTimeSec,
    restTimeSec,
    totalDurationSec,
    workTime: hms(workTimeSec),
    restTime: hms(restTimeSec),
    totalDuration: hms(totalDurationSec),
  };
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
      
      // 이벤트 발행 (WebSocket 의존성 제거)
      eventBus.emitETAUpdate(equipmentId, {
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
          id: q.id,
          position: q.queuePosition,
          userName: q.user.name,
          estimatedWaitMinutes: queueETAs[i],
        })),
        lastUpdated: new Date(),
        isAutoUpdate: true,
      });
      
      // 각 대기자에게 알림 저장 + 이벤트 발행
      queue.forEach((q, i) => {
        sendAndSaveNotification(q.userId, {
          type: 'AUTO_ETA_UPDATE',
          title: 'ETA 자동 업데이트',
          message: `${currentUsage.equipment.name} 예상 대기시간: ${queueETAs[i]}분`,
          equipmentId,
          equipmentName: currentUsage.equipment.name,
          estimatedWaitMinutes: queueETAs[i],
          queuePosition: q.queuePosition,
        });
      });
    } catch (e) {
      console.error('자동 ETA 업데이트 오류:', e);
      stopAutoUpdate(equipmentId);
    }
  }, 2 * 60 * 1000);
  
  autoUpdateIntervals.set(equipmentId, id);
}

function stopAutoUpdate(equipmentId) {
  const id = autoUpdateIntervals.get(equipmentId);
  if (id) {
    clearInterval(id);
    autoUpdateIntervals.delete(equipmentId);
  }
}

// ===== Queue Utils =====
async function reorderQueue(equipmentId) {
  const rows = await prisma.waitingQueue.findMany({
    where: { equipmentId, status: { in: ['WAITING', 'NOTIFIED'] } },
    orderBy: { createdAt: 'asc' },
  });
  
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].queuePosition !== i + 1) {
      await prisma.waitingQueue.update({
        where: { id: rows[i].id },
        data: { queuePosition: i + 1 }
      });
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
  let notificationMessage = `예약한 ${next.equipment.name} 자리가 비었어요`;
  let additionalInfo = {};
  
  if (userCurrentUsage) {
    if (userCurrentUsage.setStatus === 'RESTING') {
      notificationMessage = `예약한 ${next.equipment.name} 자리가 비었어요. (현재 ${userCurrentUsage.equipment.name} 휴식 중)`;
      additionalInfo.currentEquipmentStatus = {
        equipmentName: userCurrentUsage.equipment.name,
        status: 'resting',
        message: '휴식을 마치고 기구를 전환하세요'
      };
    } else if (userCurrentUsage.setStatus === 'EXERCISING') {
      notificationMessage = `예약한 ${next.equipment.name} 자리가 비었어요. (현재 ${userCurrentUsage.equipment.name} 운동 중)`;
      additionalInfo.currentEquipmentStatus = {
        equipmentName: userCurrentUsage.equipment.name,
        status: 'exercising',
        message: '현재 운동을 완료한 후 기구를 전환하세요',
        warning: '두 기구를 동시에 사용할 수 없습니다'
      };
    }
  }
  
  // DB 저장 + 이벤트 발행
  await sendAndSaveNotification(next.userId, {
    type: 'EQUIPMENT_AVAILABLE',
    title: '기구 사용 가능',
    message: notificationMessage,
    equipmentId,
    equipmentName: next.equipment.name,
    queueId: next.id,
    graceMinutes: 5,
    ...additionalInfo
  });
  
  // 상태 변경 이벤트 발행
  eventBus.emitEquipmentStatusChange(equipmentId, {
    type: 'next_user_notified',
    equipmentName: next.equipment.name,
    nextUserName: next.user.name,
    queuePosition: next.queuePosition,
  });
  
  setTimeout(async () => {
    const fresh = await prisma.waitingQueue.findUnique({ where: { id: next.id } });
    if (fresh && fresh.status === 'NOTIFIED') {
      await prisma.waitingQueue.update({
        where: { id: next.id },
        data: { status: 'EXPIRED' }
      });
      
      await sendAndSaveNotification(next.userId, {
        type: 'QUEUE_EXPIRED',
        title: '대기 만료',
        message: '시간 초과로 대기에서 제외되었습니다',
        equipmentId,
        equipmentName: next.equipment.name,
      });
      
      await reorderQueue(equipmentId);
      await notifyNextUser(equipmentId);
    }
  }, 5 * 60 * 1000);
  
  return true;
}

// ===== Waiting Count Notifier =====
async function notifyCurrentUserWaitingCount(equipmentId, opts = {}) {
  const { sendZero = false, cooldownMs = 60_000 } = opts;
  
  const usage = await prisma.equipmentUsage.findFirst({
    where: { equipmentId, status: 'IN_USE' },
    select: { userId: true }
  });
  
  if (!usage) return false;
  
  const [waitingCount, eq] = await Promise.all([
    prisma.waitingQueue.count({
      where: { equipmentId, status: { in: ['WAITING', 'NOTIFIED'] } }
    }),
    prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: { name: true }
    })
  ]);
  
  if (!sendZero && waitingCount <= 0) return false;
  
  const now = Date.now();
  const prev = lastWaitNotice.get(equipmentId);
  if (prev && prev.count === waitingCount && (now - prev.ts) < cooldownMs) {
    return false;
  }
  
  lastWaitNotice.set(equipmentId, { count: waitingCount, ts: now });
  
  await sendAndSaveNotification(usage.userId, {
    type: 'WAITING_COUNT',
    title: '대기자 알림',
    message: `내 뒤에 기다리는 사람이 ${waitingCount}명 있어요`,
    equipmentId,
    equipmentName: eq?.name ?? '',
    waitingCount,
    at: new Date().toISOString()
  });
  
  return true;
}

// 알림 전송 + 저장 헬퍼 (이벤트 버스 사용)
async function sendAndSaveNotification(userId, payload) {
  await saveNotification(userId, payload);
  eventBus.emitNotification(userId, payload);
  return true;
}

// ===== 🆕 사용자 운동 조회 헬퍼 =====

/**
 * 사용자의 현재 활성 운동 조회
 * @param {number} userId - 사용자 ID
 * @returns {Promise<Object|null>} 현재 사용중인 EquipmentUsage 또는 null
 */
async function getCurrentUsage(userId) {
  return await prisma.equipmentUsage.findFirst({
    where: { userId, status: 'IN_USE' },
    include: { 
      equipment: {
        select: {
          id: true,
          name: true,
          category: true,
          imageUrl: true,
          muscleGroup: true
        }
      }, 
      user: { select: { id: true, name: true } } 
    }
  });
}

/**
 * equipmentId로 특정 기구 사용 조회
 * @param {number} userId - 사용자 ID
 * @param {number} equipmentId - 기구 ID
 * @returns {Promise<Object|null>} 해당 기구의 EquipmentUsage 또는 null
 */
async function getUsageByEquipment(userId, equipmentId) {
  return await prisma.equipmentUsage.findFirst({
    where: { 
      equipmentId, 
      userId, 
      status: 'IN_USE' 
    },
    include: { 
      equipment: {
        select: {
          id: true,
          name: true,
          category: true,
          imageUrl: true,
          muscleGroup: true
        }
      }, 
      user: { select: { id: true, name: true } } 
    }
  });
}

module.exports = {
  RATE_LIMIT,
  checkRateLimit,
  calculateRealTimeETA,
  buildQueueETAs,
  startAutoUpdate,
  stopAutoUpdate,
  reorderQueue,
  notifyNextUser,
  autoUpdateCount: () => autoUpdateIntervals.size,
  userUpdateLimiter,
  initWorkAcc,
  clearWorkAcc,
  computeSummaryOnComplete,
  computeStopSummary,
  notifyCurrentUserWaitingCount,
  sendAndSaveNotification,
  // 🆕 추가
  getCurrentUsage,
  getUsageByEquipment,
};