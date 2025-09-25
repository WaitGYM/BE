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
