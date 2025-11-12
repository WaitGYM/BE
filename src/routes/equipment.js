const sanitizeUrl = (url) => {
  if (!url) return null;
  
  try {
    const urlObj = new URL(url);
    return url
      .trim()
      .replace(/[\r\n\t]/g, '')
      .replace(/\s+/g, '%20');
  } catch (e) {
    console.error('Invalid URL:', url);
    return null;
  }
};
const { getTodayWorkoutStats } = require('../services/workout-stats.service');
const router = require('express').Router();
const { auth } = require('../middleware/auth');
const { authOptional } = require('../utils/authOptional');
const { getEquipmentStatusInfo } = require('../services/equipment.service');
const { rangeTodayKST } = require('../utils/time');
const asyncRoute = require('../utils/asyncRoute');
const prisma = require('../lib/prisma');

// GET /api/equipment
// GET /api/equipment
router.get('/', asyncRoute(async (req, res) => {
  const { category, search, include_status = 'true', sort_by } = req.query; // sort_by 추가
  const { userId } = authOptional(req);

  const where = {};
  if (category && category !== 'all') where.category = category;
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { muscleGroup: { contains: search, mode: 'insensitive' } },
    ];
  }

  const list = await prisma.equipment.findMany({
    where,
    orderBy: { name: 'asc' },
    include: {
      _count: { select: { waitingQueues: true } },
      favorites: userId ? { where: { userId }, select: { id: true } } : false,
    },
  });

  let statusMap = new Map();
  if (include_status === 'true') {
    statusMap = await getEquipmentStatusInfo(list.map((e) => e.id), userId);
  }

  const response = list.map((e) => {
    const base = {
      id: e.id,
      name: e.name,
      imageUrl: sanitizeUrl(e.imageUrl),
      category: e.category,
      muscleGroup: e.muscleGroup,
      createdAt: e.createdAt,
      isFavorite: !!userId && Array.isArray(e.favorites) && e.favorites.length > 0,
    };

    if (include_status !== 'true') return base;

    const baseStatus = {
      isAvailable: true,
      currentUser: null,
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
      equipmentStatus: 'available',
      statusMessage: '사용 가능',
      statusColor: 'green',
    };

    const computed = statusMap.get(e.id) || {};
    const status = { ...baseStatus, ...computed };
    return { ...base, status };
  });

  // 🆕 정렬 로직 추가
  if (sort_by === 'available') {
    response.sort((a, b) => {
      // 1순위: 사용 가능 여부 (available 먼저)
      if (a.status.isAvailable !== b.status.isAvailable) {
        return a.status.isAvailable ? -1 : 1;
      }
      
      // 2순위: 대기 인원 수 (적은 순)
      if (a.status.waitingCount !== b.status.waitingCount) {
        return a.status.waitingCount - b.status.waitingCount;
      }
      
      // 3순위: 예상 대기시간 (짧은 순)
      return a.status.estimatedWaitMinutes - b.status.estimatedWaitMinutes;
    });
  } else if (sort_by === 'waiting_asc') {
    // 대기 인원 적은 순만
    response.sort((a, b) => a.status.waitingCount - b.status.waitingCount);
  } else if (sort_by === 'waiting_desc') {
    // 대기 인원 많은 순
    response.sort((a, b) => b.status.waitingCount - a.status.waitingCount);
  }

  res.json(response);
}));

// GET /api/equipment/search
router.get('/search', asyncRoute(async (req, res) => {
  const { q, category, available_only } = req.query;
  const { userId } = authOptional(req);

  const where = {};
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { category: { contains: q, mode: 'insensitive' } },
      { muscleGroup: { contains: q, mode: 'insensitive' } },
    ];
  }
  if (category && category !== 'all') where.category = category;

  const equipmentList = await prisma.equipment.findMany({
    where,
    orderBy: { name: 'asc' },
    include: {
      favorites: userId ? { where: { userId }, select: { id: true } } : false
    },
  });

  const statusMap = await getEquipmentStatusInfo(equipmentList.map((e) => e.id), userId);
  
  let response = equipmentList.map((e) => ({
    id: e.id,
    name: e.name,
    imageUrl: e.imageUrl,
    category: e.category,
    muscleGroup: e.muscleGroup,
    createdAt: e.createdAt,
    isFavorite: !!userId && e.favorites.length > 0,
    status: statusMap.get(e.id),
  }));

  if (available_only === 'true') {
    response = response.filter((eq) => eq.status.isAvailable);
  }

  res.json(response);
}));

// GET /api/equipment/categories
router.get('/categories', asyncRoute(async (_req, res) => {
  const categories = await prisma.equipment.groupBy({
    by: ['category'],
    _count: { category: true },
    orderBy: { category: 'asc' }
  });
  res.json(categories.map((c) => ({
    name: c.category,
    count: c._count.category
  })));
}));

// GET /api/equipment/status?equipmentIds=1,2
router.get('/status', asyncRoute(async (req, res) => {
  const { equipmentIds } = req.query;
  const { userId } = authOptional(req);
  
  if (!equipmentIds) {
    return res.status(400).json({ error: 'equipmentIds 파라미터가 필요합니다' });
  }

  const ids = equipmentIds.split(',').map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
  
  if (ids.length === 0) {
    return res.status(400).json({ error: '유효한 equipmentIds가 필요합니다' });
  }

  const statusMap = await getEquipmentStatusInfo(ids, userId);
  const statusObject = {};
  statusMap.forEach((v, k) => {
    statusObject[k] = v;
  });
  
  res.json(statusObject);
}));

// GET /api/equipment/my-completed
router.get('/my-completed', auth(), asyncRoute(async (req, res) => {
  const { date, limit = 20 } = req.query;

  const where = { userId: req.user.id, status: 'COMPLETED' };
  
  if (date) {
    const d = new Date(date);
    const { start, end } = rangeTodayKST(d);
    where.endedAt = { gte: start, lte: end };
  }

  const rows = await prisma.equipmentUsage.findMany({
    where,
    include: {
      equipment: {
        select: { id: true, name: true, category: true, muscleGroup: true, imageUrl: true }
      }
    },
    orderBy: { endedAt: 'desc' },
    take: parseInt(limit, 10),
  });

  const resp = rows.map((u) => ({
    id: u.id,
    equipmentId: u.equipmentId,
    equipment: u.equipment,
    startedAt: u.startedAt,
    endedAt: u.endedAt,
    totalSets: u.totalSets,
    completedSets: u.currentSet,
    restSeconds: typeof u.restSeconds === 'number' ? u.restSeconds : null,
    setStatus: u.setStatus,
    durationSeconds: (u.startedAt && u.endedAt) ? Math.round((u.endedAt - u.startedAt) / 1000) : null,
    isFullyCompleted: u.setStatus === 'COMPLETED',
    wasInterrupted: ['STOPPED', 'FORCE_COMPLETED'].includes(u.setStatus),
  }));

  res.json(resp);
}));

// GET /api/equipment/my-stats
router.get('/my-stats', auth(), asyncRoute(async (req, res) => {
  const { period = 'week' } = req.query;
  const now = new Date();
  let startDate;
  
  switch (period) {
    case 'today':
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case 'week':
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case 'month':
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'year':
      startDate = new Date(now.getFullYear(), 0, 1);
      break;
    default:
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  }

  const stats = await prisma.equipmentUsage.findMany({
    where: {
      userId: req.user.id,
      status: 'COMPLETED',
      endedAt: { gte: startDate }
    },
    include: {
      equipment: { select: { id: true, name: true, category: true } }
    },
    orderBy: { endedAt: 'asc' },
  });

  const equipmentStats = {};
  const categoryStats = {};
  let totalSets = 0;
  let totalSeconds = 0;

  stats.forEach((u) => {
    const k = u.equipmentId;
    if (!equipmentStats[k]) {
      equipmentStats[k] = {
        equipment: u.equipment,
        count: 0,
        totalSets: 0,
        totalSeconds: 0,
        lastUsed: null
      };
    }
    equipmentStats[k].count += 1;
    equipmentStats[k].totalSets += (u.currentSet || 0);
    
    if (u.startedAt && u.endedAt) {
      const s = Math.round((u.endedAt - u.startedAt) / 1000);
      equipmentStats[k].totalSeconds += s;
      equipmentStats[k].lastUsed = !equipmentStats[k].lastUsed || u.endedAt > equipmentStats[k].lastUsed
        ? u.endedAt
        : equipmentStats[k].lastUsed;
      totalSeconds += s;
    }
    totalSets += (u.currentSet || 0);

    const cat = u.equipment?.category || '기타';
    if (!categoryStats[cat]) {
      categoryStats[cat] = { count: 0, totalSets: 0 };
    }
    categoryStats[cat].count += 1;
    categoryStats[cat].totalSets += (u.currentSet || 0);
  });

  res.json({
    period,
    totalWorkouts: stats.length,
    totalSets,
    totalSeconds,
    averageSetsPerWorkout: stats.length ? Math.round(totalSets / stats.length) : 0,
    equipmentStats: Object.values(equipmentStats).sort((a, b) => b.count - a.count),
    categoryStats: Object.entries(categoryStats)
      .map(([category, data]) => ({ category, ...data }))
      .sort((a, b) => b.count - a.count),
    recentWorkouts: stats.slice(-5).reverse(),
  });
}));


// GET /api/equipment/today-total-time - 오늘 하루 총 운동시간 조회
router.get('/today-total-time', auth(), asyncRoute(async (req, res) => {
  const userId = req.user.id;
  
  // 서비스에서 통계 조회
  const stats = await getTodayWorkoutStats(userId);
  
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  // 인사이트 생성
  const insights = {
    mostUsedEquipment: null,
    mostTrainedCategory: null,
    longestWorkout: null
  };
  
  // 가장 많이 사용한 기구
  if (stats.equipmentStats.length > 0) {
    const mostUsed = stats.equipmentStats[0];
    insights.mostUsedEquipment = {
      name: mostUsed.equipment.name,
      count: mostUsed.count,
      totalTime: mostUsed.totalTimeFormatted
    };
  }
  
  // 가장 많이 훈련한 카테고리
  if (stats.categoryStats.length > 0) {
    const mostTrained = stats.categoryStats[0];
    insights.mostTrainedCategory = {
      category: mostTrained.category,
      percentage: mostTrained.percentage,
      totalTime: mostTrained.totalTimeFormatted
    };
  }
  
  // 가장 긴 운동
  if (stats.workoutDetails.length > 0) {
    const longest = stats.workoutDetails.reduce((max, workout) => 
      workout.durationSeconds > max.durationSeconds ? workout : max
    , stats.workoutDetails[0]);
    
    insights.longestWorkout = {
      equipmentName: longest.equipmentName,
      duration: longest.durationFormatted,
      sets: longest.sets
    };
  }
  
  res.json({
    date: startOfToday.toISOString().split('T')[0],
    summary: stats.summary,
    workouts: stats.workoutDetails,
    categoryBreakdown: stats.categoryStats,
    insights: insights
  });
}));

// GET /api/equipment/:id
router.get('/:id', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const { userId } = authOptional(req);

  const equipment = await prisma.equipment.findUnique({
    where: { id },
    include: {
      favorites: userId ? { where: { userId }, select: { id: true } } : false,
      _count: { select: { favorites: true } },
    },
  });
  
  if (!equipment) {
    return res.status(404).json({ error: '기구를 찾을 수 없습니다' });
  }

  const status = (await getEquipmentStatusInfo([id], userId)).get(id);

  res.json({
    id: equipment.id,
    name: equipment.name,
    imageUrl: equipment.imageUrl,
    category: equipment.category,
    muscleGroup: equipment.muscleGroup,
    createdAt: equipment.createdAt,
    isFavorite: !!userId && equipment.favorites.length > 0,
    favoriteCount: equipment._count.favorites,
    status,
  });
}));

// POST /api/equipment/:id/quick-start
router.post('/:id/quick-start', auth(), asyncRoute(async (req, res) => {
  const equipmentId = parseInt(req.params.id, 10);
  const { totalSets = 3, restSeconds = 180 } = req.body;

  const equipment = await prisma.equipment.findUnique({ where: { id: equipmentId } });
  if (!equipment) {
    return res.status(404).json({ error: '기구를 찾을 수 없습니다' });
  }

  const currentUsage = await prisma.equipmentUsage.findFirst({
    where: { equipmentId, status: 'IN_USE' },
    include: { user: { select: { name: true } } },
  });
  
  if (currentUsage) {
    return res.status(409).json({
      error: '기구가 사용 중입니다',
      currentUser: currentUsage.user.name,
      startedAt: currentUsage.startedAt,
      message: '대기열에 등록하거나 나중에 다시 시도해주세요',
    });
  }

  const myUsage = await prisma.equipmentUsage.findFirst({
    where: { userId: req.user.id, status: 'IN_USE' },
    include: { equipment: { select: { name: true } } }
  });

  if (myUsage && myUsage.equipmentId === equipmentId) {
    return res.status(409).json({
      error: '현재 사용 중인 기구입니다',
      message: '사용이 완료된 후 다시 대기할 수 있습니다',
      currentEquipment: myUsage.equipment.name
    });
  }

  const firstInQueue = await prisma.waitingQueue.findFirst({
    where: { equipmentId, status: { in: ['WAITING', 'NOTIFIED'] } },
    orderBy: { queuePosition: 'asc' },
  });
  
  if (firstInQueue && firstInQueue.userId !== req.user.id) {
    return res.status(403).json({
      error: '대기 순서가 아닙니다',
      message: '먼저 대기열에 등록해주세요'
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
        restSeconds,
        status: 'IN_USE',
        setStatus: 'EXERCISING',
        currentSet: 1,
        currentSetStartedAt: new Date(),
        estimatedEndAt: new Date(Date.now() + totalDurationSeconds * 1000),
      },
    });
    
    if (firstInQueue && firstInQueue.userId === req.user.id) {
      await tx.waitingQueue.update({
        where: { id: firstInQueue.id },
        data: { status: 'COMPLETED' }
      });
    }
    
    return newUsage;
  });

  res.json({
    message: `${equipment.name} 사용을 시작했습니다`,
    equipmentName: equipment.name,
    totalSets,
    restSeconds,
    usageId: usage.id
  });
}));

// POST /api/equipment/:id/quick-queue
router.post('/:id/quick-queue', auth(), asyncRoute(async (req, res) => {
  const equipmentId = parseInt(req.params.id, 10);

  const equipment = await prisma.equipment.findUnique({ where: { id: equipmentId } });
  if (!equipment) {
    return res.status(404).json({ error: '기구를 찾을 수 없습니다' });
  }

  const existingQueue = await prisma.waitingQueue.findFirst({
    where: {
      equipmentId,
      userId: req.user.id,
      status: { in: ['WAITING', 'NOTIFIED'] }
    },
  });
  
  if (existingQueue) {
    return res.status(409).json({
      error: '이미 대기열에 등록되어 있습니다',
      queuePosition: existingQueue.queuePosition,
      status: existingQueue.status
    });
  }

  const myUsage = await prisma.equipmentUsage.findFirst({
    where: { userId: req.user.id, status: 'IN_USE' },
    include: { equipment: { select: { name: true } } }
  });
  
  if (myUsage) {
    return res.status(409).json({
      error: '이미 다른 기구를 사용 중입니다',
      currentEquipment: myUsage.equipment.name
    });
  }

  const length = await prisma.waitingQueue.count({
    where: { equipmentId, status: { in: ['WAITING', 'NOTIFIED'] } }
  });
  
  const queue = await prisma.waitingQueue.create({
    data: {
      equipmentId,
      userId: req.user.id,
      queuePosition: length + 1,
      status: 'WAITING'
    },
    include: {
      equipment: true,
      user: { select: { name: true } }
    }
  });

  const response = {
    message: `${queue.equipment?.name ?? ''} 대기열에 등록되었습니다`,
    equipmentName: queue.equipment?.name || '',
    queuePosition: queue.queuePosition,
    queueId: queue.id,
    estimatedWaitSeconds: Math.max(300, length * 900),
  };

  if (myUsage) {
    response.warning = {
      message: myUsage.setStatus === 'RESTING'
        ? `현재 ${myUsage.equipment?.name ?? ''}에서 휴식 중입니다. 대기 차례가 오면 알림을 받게 됩니다.`
        : `현재 ${myUsage.equipment?.name ?? ''}에서 운동 중입니다. 두 기구를 동시에 사용할 수 없으니 주의하세요.`,
      currentEquipment: myUsage.equipment?.name || '',
      currentStatus: myUsage.setStatus,
    };
  }

  res.status(201).json(response);
}));

module.exports = router;