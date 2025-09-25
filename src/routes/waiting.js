const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const { auth } = require('../middleware/auth');
const asyncRoute = require('../utils/asyncRoute');
const {
  RATE_LIMIT, checkRateLimit,
  calculateRealTimeETA, buildQueueETAs,
  startAutoUpdate, stopAutoUpdate,
  reorderQueue, notifyNextUser,
  autoUpdateCount, userUpdateLimiter,
} = require('../services/waiting.service');

const prisma = new PrismaClient();

// POST /api/waiting/queue/:equipmentId - 대기열 등록
router.post('/queue/:equipmentId', auth(), asyncRoute(async (req, res) => {
  const equipmentId = parseInt(req.params.equipmentId, 10);

  const equipment = await prisma.equipment.findUnique({ where: { id: equipmentId } });
  if (!equipment) return res.status(404).json({ error: '기구를 찾을 수 없습니다' });

  // 이미 내 대기가 있으면 차단
  const existingQueue = await prisma.waitingQueue.findFirst({
    where: { equipmentId, userId: req.user.id, status: { in: ['WAITING', 'NOTIFIED'] } },
  });
  if (existingQueue) {
    return res.status(409).json({
      error: '이미 대기열에 등록되어 있습니다',
      queuePosition: existingQueue.queuePosition,
      status: existingQueue.status,
    });
  }

  // 다른 기구 사용 중이면 차단
  const myUsage = await prisma.equipmentUsage.findFirst({
    where: { userId: req.user.id, status: 'IN_USE' },
    include: { equipment: { select: { name: true } } },
  });
  if (myUsage) {
    return res.status(409).json({
      error: '이미 다른 기구를 사용 중입니다',
      currentEquipment: myUsage.equipment.name,
      equipmentId: myUsage.equipmentId,
    });
  }

  // 현재 대기 길이 → 나의 position
  const length = await prisma.waitingQueue.count({
    where: { equipmentId, status: { in: ['WAITING', 'NOTIFIED'] } },
  });

  const queue = await prisma.waitingQueue.create({
    data: {
      equipmentId,
      userId: req.user.id,
      queuePosition: length + 1,
      status: 'WAITING',
    },
    include: { user: { select: { name: true } } },
  });

  // 예상 대기시간 계산
  const currentUsage = await prisma.equipmentUsage.findFirst({
    where: { equipmentId, status: 'IN_USE' },
  });

  let estimatedWaitMinutes = 0;
  if (currentUsage) {
    const queueList = await prisma.waitingQueue.findMany({
      where: { equipmentId, status: { in: ['WAITING', 'NOTIFIED'] } },
      orderBy: { queuePosition: 'asc' },
    });
    const currentETA = calculateRealTimeETA(currentUsage);
    const etas = buildQueueETAs(currentETA, queueList);
    const idx = queueList.findIndex((q) => q.id === queue.id);
    estimatedWaitMinutes = etas[idx] ?? 0;

    // 자동 ETA 업데이트 루프 보장
    startAutoUpdate(equipmentId);
  } else {
    // 기구가 비어 있다면 바로 다음 사용자 알림(내가 NOTIFIED가 됨)
    setTimeout(() => notifyNextUser(equipmentId), 300);
  }

  // 실시간 브로드캐스트
  require('../websocket').broadcastEquipmentStatusChange(equipmentId, {
    type: 'queue_joined',
    equipmentName: equipment.name,
    userName: queue.user.name,
    queuePosition: queue.queuePosition,
    queueId: queue.id,
  });

  res.status(201).json({
    message: `${equipment.name} 대기열에 등록되었습니다`,
    equipmentName: equipment.name,
    queuePosition: queue.queuePosition,
    queueId: queue.id,
    estimatedWaitMinutes,
  });
}));


// POST /api/waiting/update-eta/:equipmentId
router.post('/update-eta/:equipmentId', auth(), asyncRoute(async (req, res) => {
  const equipmentId = parseInt(req.params.equipmentId, 10);
  const userId = req.user.id;

  const rl = checkRateLimit(userId);
  if (!rl.allowed) {
    const remainingSeconds = Math.ceil(rl.remainingMs / 1000);
    return res.status(429).json({
      error: rl.reason === 'cooldown' ? '너무 자주 업데이트했습니다' : '업데이트 횟수 초과',
      remainingSeconds,
      message: `${remainingSeconds}초 후 다시 시도해주세요`,
    });
  }

  const equipment = await prisma.equipment.findUnique({ where: { id: equipmentId } });
  if (!equipment) return res.status(404).json({ error: '기구를 찾을 수 없습니다' });

  const [currentUsage, queue] = await Promise.all([
    prisma.equipmentUsage.findFirst({ where: { equipmentId, status: 'IN_USE' }, include: { user: { select: { name: true } } } }),
    prisma.waitingQueue.findMany({ where: { equipmentId, status: { in: ['WAITING', 'NOTIFIED'] } }, orderBy: { queuePosition: 'asc' }, include: { user: { select: { name: true } } } }),
  ]);

  const currentETA = currentUsage ? calculateRealTimeETA(currentUsage) : 0;
  const queueETAs = buildQueueETAs(currentETA, queue);
  const updateTime = new Date();

  const updateData = {
    equipmentId,
    equipmentName: equipment.name,
    updatedAt: updateTime,
    updatedBy: userId,
    currentUsage: currentUsage ? {
      userName: currentUsage.user.name, totalSets: currentUsage.totalSets, currentSet: currentUsage.currentSet,
      setStatus: currentUsage.setStatus, estimatedMinutesLeft: currentETA, progress: Math.round((currentUsage.currentSet / currentUsage.totalSets) * 100),
    } : null,
    waitingQueue: queue.map((q, i) => ({ id: q.id, position: q.queuePosition, userName: q.user.name, estimatedWaitMinutes: queueETAs[i], isYou: q.userId === userId })),
    totalWaiting: queue.length,
    isManualUpdate: true,
  };

  // 브로드캐스트 & 개별 알림
  const { broadcastETAUpdate } = require('../websocket');
  broadcastETAUpdate(equipmentId, updateData);
  queue.forEach((q, i) => require('../websocket').sendNotification(q.userId, {
    type: 'ETA_UPDATED',
    title: 'ETA 업데이트',
    message: `${equipment.name} 예상 대기시간: ${queueETAs[i]}분`,
    equipmentId, equipmentName: equipment.name, estimatedWaitMinutes: queueETAs[i], queuePosition: q.queuePosition, updatedAt: updateTime, updatedBy: q.userId === userId ? '나' : '다른 사용자',
  }));

  res.json(updateData);
}));

// POST /api/waiting/start-using/:equipmentId
router.post('/start-using/:equipmentId', auth(), asyncRoute(async (req, res) => {
  const equipmentId = parseInt(req.params.equipmentId, 10);
  const { totalSets = 3, restSeconds = 180 } = req.body;

  const equipment = await prisma.equipment.findUnique({ where: { id: equipmentId } });
  if (!equipment) return res.status(404).json({ error: '기구 없음' });

  const currentUsage = await prisma.equipmentUsage.findFirst({ where: { equipmentId, status: 'IN_USE' }, include: { user: true } });
  if (currentUsage) return res.status(409).json({ error: '이미 사용 중', currentUser: currentUsage.user.name, since: currentUsage.startedAt });

  const myUsage = await prisma.equipmentUsage.findFirst({ where: { userId: req.user.id, status: 'IN_USE' }, include: { equipment: true } });
  if (myUsage) return res.status(409).json({ error: '다른 기구 사용 중', currentEquipment: myUsage.equipment.name, equipmentId: myUsage.equipmentId });

  const firstInQueue = await prisma.waitingQueue.findFirst({ where: { equipmentId, status: { in: ['WAITING', 'NOTIFIED'] } }, orderBy: { queuePosition: 'asc' } });
  if (firstInQueue && firstInQueue.userId !== req.user.id) return res.status(403).json({ error: '대기 순서가 아님', firstPosition: firstInQueue.queuePosition });

  const usage = await prisma.$transaction(async (tx) => {
    const u = await tx.equipmentUsage.create({
      data: {
        equipmentId, userId: req.user.id, totalSets, currentSet: 1, restSeconds,
        status: 'IN_USE', setStatus: 'EXERCISING', currentSetStartedAt: new Date(),
        estimatedEndAt: new Date(Date.now() + ((totalSets * 5 * 60) + ((totalSets - 1) * restSeconds)) * 1000),
      },
      include: { equipment: true, user: { select: { name: true } } },
    });
    if (firstInQueue && firstInQueue.userId === req.user.id) {
      await tx.waitingQueue.update({ where: { id: firstInQueue.id }, data: { status: 'COMPLETED' } });
    }
    return u;
  });

  require('../websocket').broadcastEquipmentStatusChange(equipmentId, {
    type: 'usage_started', equipmentName: equipment.name, userName: usage.user.name, totalSets: usage.totalSets, startedAt: usage.startedAt,
  });

  startAutoUpdate(equipmentId);

  res.status(201).json({
    id: usage.id, equipmentId: usage.equipmentId, equipmentName: usage.equipment.name,
    totalSets: usage.totalSets, currentSet: usage.currentSet, setStatus: usage.setStatus, restSeconds: usage.restSeconds,
    startedAt: usage.startedAt, estimatedEndAt: usage.estimatedEndAt, progress: Math.round((usage.currentSet / usage.totalSets) * 100),
  });
}));

// POST /api/waiting/complete-set/:equipmentId
router.post('/complete-set/:equipmentId', auth(), asyncRoute(async (req, res) => {
  const equipmentId = parseInt(req.params.equipmentId, 10);
  const usage = await prisma.equipmentUsage.findFirst({ where: { equipmentId, userId: req.user.id, status: 'IN_USE' }, include: { equipment: true, user: { select: { name: true } } } });
  if (!usage) return res.status(404).json({ error: '사용 중 아님' });
  if (usage.setStatus !== 'EXERCISING') return res.status(400).json({ error: 'EXERCISING 상태가 아님', currentStatus: usage.setStatus });

  const isLastSet = usage.currentSet >= usage.totalSets;
  if (isLastSet) {
    await prisma.equipmentUsage.update({ where: { id: usage.id }, data: { status: 'COMPLETED', setStatus: 'COMPLETED', endedAt: new Date() } });

    require('../websocket').broadcastEquipmentStatusChange(equipmentId, {
      type: 'usage_completed', equipmentName: usage.equipment.name, userName: usage.user.name, totalSets: usage.totalSets, completedAt: new Date(),
    });

    stopAutoUpdate(equipmentId);
    setTimeout(() => notifyNextUser(equipmentId), 1000);
    return res.json({ message: `전체 ${usage.totalSets}세트 완료!`, completed: true });
  }

  await prisma.equipmentUsage.update({ where: { id: usage.id }, data: { setStatus: 'RESTING', restStartedAt: new Date() } });

  require('../websocket').broadcastEquipmentStatusChange(equipmentId, {
    type: 'rest_started', equipmentName: usage.equipment.name, userName: usage.user.name, currentSet: usage.currentSet, totalSets: usage.totalSets, restSeconds: usage.restSeconds,
  });

  require('../websocket').sendNotification(req.user.id, { type: 'REST_STARTED', title: '휴식 시작', message: `${usage.currentSet}/${usage.totalSets} 세트 완료`, equipmentId, restSeconds: usage.restSeconds });

  if (usage.restSeconds > 0) {
    setTimeout(async () => {
      const current = await prisma.equipmentUsage.findUnique({ where: { id: usage.id }, include: { equipment: true, user: { select: { name: true } } } });
      if (current && current.setStatus === 'RESTING' && current.status === 'IN_USE') {
        await prisma.equipmentUsage.update({ where: { id: usage.id }, data: { currentSet: current.currentSet + 1, setStatus: 'EXERCISING', currentSetStartedAt: new Date(), restStartedAt: null } });
        require('../websocket').broadcastEquipmentStatusChange(equipmentId, { type: 'next_set_started', equipmentName: current.equipment.name, userName: current.user.name, currentSet: current.currentSet + 1, totalSets: current.totalSets });
        require('../websocket').sendNotification(req.user.id, { type: 'NEXT_SET_STARTED', title: '다음 세트', message: `${current.currentSet + 1}/${current.totalSets} 세트 시작`, equipmentId });
      }
    }, usage.restSeconds * 1000);
  }

  res.json({ message: `${usage.currentSet}/${usage.totalSets} 세트 완료`, setStatus: 'RESTING', restSeconds: usage.restSeconds });
}));

// POST /api/waiting/skip-rest/:equipmentId
router.post('/skip-rest/:equipmentId', auth(), asyncRoute(async (req, res) => {
  const equipmentId = parseInt(req.params.equipmentId, 10);
  const usage = await prisma.equipmentUsage.findFirst({ where: { equipmentId, userId: req.user.id, status: 'IN_USE' }, include: { equipment: true, user: { select: { name: true } } } });
  if (!usage) return res.status(404).json({ error: '현재 사용 중인 기구가 없습니다' });
  if (usage.setStatus !== 'RESTING') return res.status(400).json({ error: '휴식 중이 아닙니다', currentStatus: usage.setStatus, message: '휴식 중일 때만 건너뛸 수 있습니다' });

  const nextSet = usage.currentSet + 1;
  const isLastSet = nextSet > usage.totalSets;

  if (isLastSet) {
    await prisma.equipmentUsage.update({ where: { id: usage.id }, data: { status: 'COMPLETED', setStatus: 'COMPLETED', endedAt: new Date() } });
    require('../websocket').broadcastEquipmentStatusChange(equipmentId, { type: 'usage_completed', equipmentName: usage.equipment.name, userName: usage.user.name, totalSets: usage.totalSets, completedAt: new Date(), wasSkipped: true });
    stopAutoUpdate(equipmentId);
    setTimeout(() => notifyNextUser(equipmentId), 1000);
    return res.json({ message: `전체 ${usage.totalSets}세트 완료!`, completed: true, skippedRest: true });
  }

  await prisma.equipmentUsage.update({ where: { id: usage.id }, data: { currentSet: nextSet, setStatus: 'EXERCISING', currentSetStartedAt: new Date(), restStartedAt: null } });
  require('../websocket').broadcastEquipmentStatusChange(equipmentId, { type: 'rest_skipped', equipmentName: usage.equipment.name, userName: usage.user.name, currentSet: nextSet, totalSets: usage.totalSets, skippedAt: new Date() });
  require('../websocket').sendNotification(req.user.id, { type: 'REST_SKIPPED', title: '휴식 건너뛰기', message: `${nextSet}/${usage.totalSets} 세트 시작`, equipmentId, currentSet: nextSet, totalSets: usage.totalSets });

  res.json({ message: `휴식을 건너뛰고 ${nextSet}/${usage.totalSets} 세트를 시작합니다`, currentSet: nextSet, totalSets: usage.totalSets, setStatus: 'EXERCISING', skippedRest: true, progress: Math.round((nextSet / usage.totalSets) * 100) });
}));

// POST /api/waiting/stop-exercise/:equipmentId
router.post('/stop-exercise/:equipmentId', auth(), asyncRoute(async (req, res) => {
  const equipmentId = parseInt(req.params.equipmentId, 10);
  const usage = await prisma.equipmentUsage.findFirst({ where: { equipmentId, userId: req.user.id, status: 'IN_USE' }, include: { equipment: true, user: { select: { name: true } } } });
  if (!usage) return res.status(404).json({ error: '사용 중 아님' });

  await prisma.equipmentUsage.update({ where: { id: usage.id }, data: { status: 'COMPLETED', setStatus: 'STOPPED', endedAt: new Date() } });
  require('../websocket').broadcastEquipmentStatusChange(equipmentId, { type: 'usage_stopped', equipmentName: usage.equipment.name, userName: usage.user.name, completedSets: usage.currentSet, totalSets: usage.totalSets, stoppedAt: new Date() });
  require('../websocket').sendNotification(req.user.id, { type: 'EXERCISE_STOPPED', title: '운동 중단', message: `${usage.equipment.name} 운동 중단`, equipmentId });
  stopAutoUpdate(equipmentId);
  setTimeout(() => notifyNextUser(equipmentId), 1000);
  res.json({ message: '운동 중단 완료' });
}));

// GET /api/waiting/status/:equipmentId
router.get('/status/:equipmentId', asyncRoute(async (req, res) => {
  const equipmentId = parseInt(req.params.equipmentId, 10);
  const equipment = await prisma.equipment.findUnique({ where: { id: equipmentId } });
  if (!equipment) return res.status(404).json({ error: '기구를 찾을 수 없습니다' });

  const [currentUsage, queue] = await Promise.all([
    prisma.equipmentUsage.findFirst({ where: { equipmentId, status: 'IN_USE' }, include: { user: { select: { name: true } } } }),
    prisma.waitingQueue.findMany({ where: { equipmentId, status: { in: ['WAITING', 'NOTIFIED'] } }, orderBy: { queuePosition: 'asc' }, include: { user: { select: { name: true } } } }),
  ]);

  const currentETA = currentUsage ? calculateRealTimeETA(currentUsage) : 0;
  const queueETAs = buildQueueETAs(currentETA, queue);

  let setProgress = null;
  if (currentUsage && currentUsage.setStatus === 'EXERCISING' && currentUsage.currentSetStartedAt) {
    const elapsed = Date.now() - currentUsage.currentSetStartedAt.getTime();
    const estimatedSetTime = 3 * 60 * 1000;
    setProgress = Math.min(100, Math.round((elapsed / estimatedSetTime) * 100));
  }

  res.json({
    equipmentId, equipmentName: equipment.name, isAvailable: !currentUsage, lastUpdated: new Date(),
    currentUser: currentUsage ? {
      name: currentUsage.user.name, startedAt: currentUsage.startedAt, totalSets: currentUsage.totalSets, currentSet: currentUsage.currentSet,
      setStatus: currentUsage.setStatus, restSeconds: currentUsage.restSeconds,
      progress: Math.round((currentUsage.currentSet / currentUsage.totalSets) * 100),
      setProgress, estimatedMinutesLeft: currentETA,
      restTimeLeft: currentUsage.setStatus === 'RESTING' && currentUsage.restStartedAt
        ? Math.max(0, Math.ceil((currentUsage.restSeconds * 1000 - (Date.now() - currentUsage.restStartedAt.getTime())) / 1000)) : 0,
    } : null,
    waitingQueue: queue.map((q, i) => ({ id: q.id, position: q.queuePosition, userName: q.user.name, status: q.status, createdAt: q.createdAt, notifiedAt: q.notifiedAt, estimatedWaitMinutes: queueETAs[i] || 0 })),
    totalWaiting: queue.length,
    averageWaitTime: queue.length ? Math.round(queueETAs.reduce((a, b) => a + b, 0) / queue.length) : 0,
  });
}));

// DELETE /api/waiting/queue/:queueId
router.delete('/queue/:queueId', auth(), asyncRoute(async (req, res) => {
  const queueId = parseInt(req.params.queueId, 10);
  if (!queueId) return res.status(400).json({ error: '유효한 queueId가 필요합니다' });

  // 대상 큐 조회
  const q = await prisma.waitingQueue.findUnique({
    where: { id: queueId },
    include: { equipment: true },
  });
  if (!q) return res.status(404).json({ error: '대기열 항목을 찾을 수 없습니다' });

  // 소유자(또는 관리자)만 취소 가능
  // (관리자 권한 필드가 있다면 req.user.role === 'ADMIN' 같은 체크를 병행)
  if (q.userId !== req.user.id /* && req.user.role !== 'ADMIN' */) {
    return res.status(403).json({ error: '본인 대기열만 취소할 수 있습니다' });
  }

  // 활성 상태만 취소 허용
  if (!['WAITING', 'NOTIFIED'].includes(q.status)) {
    return res.status(409).json({ error: '이미 활성 대기열이 아닙니다', status: q.status });
  }

  // 상태 비활성화 처리
  // (스키마 열거형에 CANCELLED가 없다면 EXPIRED를 사용해 비활성화 상태로 둡니다)
  await prisma.waitingQueue.update({
    where: { id: queueId },
    data: { status: 'EXPIRED' },
  });

  // 포지션 재정렬
  const remaining = await reorderQueue(q.equipmentId);

  // 내가 NOTIFIED(호출받은 상태)였으면 다음 사람에게 알림
  if (q.status === 'NOTIFIED') {
    setTimeout(() => notifyNextUser(q.equipmentId), 500);
  }

  // 실시간 브로드캐스트
  const { broadcastEquipmentStatusChange } = require('../websocket');
  broadcastEquipmentStatusChange(q.equipmentId, {
    type: 'queue_cancelled',
    equipmentName: q.equipment.name,
    cancelledQueueId: q.id,
    remainingWaiting: remaining,
    cancelledBy: req.user.id,
  });

  res.status(200).json({
    message: '대기열이 취소되었습니다',
    queueId: q.id,
    equipmentId: q.equipmentId,
    equipmentName: q.equipment.name,
    prevStatus: q.status,
    remainingWaiting: remaining,
  });
}));

// GET /api/waiting/admin/stats
router.get('/admin/stats', auth(), asyncRoute(async (_req, res) => {
  const [activeUsages, activeQueues] = await Promise.all([
    prisma.equipmentUsage.count({ where: { status: 'IN_USE' } }),
    prisma.waitingQueue.count({ where: { status: { in: ['WAITING', 'NOTIFIED'] } } }),
  ]);
  res.json({
    activeUsages, activeQueues,
    autoUpdateCount: autoUpdateCount(),
    rateLimitedUsers: userUpdateLimiter.size,
    timestamp: new Date(),
    rateLimitPolicy: RATE_LIMIT,
  });
}));

module.exports = { router };
