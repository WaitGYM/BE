// src/routes/notifications.js

const router = require('express').Router();
const { auth } = require('../middleware/auth');
const asyncRoute = require('../utils/asyncRoute');
const {
  getNotifications,
  markAsRead,
  markAllAsRead,
  getNotificationStats,
} = require('../services/notification.service');

/**
 * GET /api/notifications
 * 알림 목록 조회
 */
router.get('/', auth(), asyncRoute(async (req, res) => {
  const {
    limit = 50,
    offset = 0,
    isRead,
    category,
    days = 30,
    equipmentId,
  } = req.query;
  
  const options = {
    limit: Math.min(parseInt(limit, 10), 100), // 최대 100개
    offset: parseInt(offset, 10) || 0,
    days: Math.min(parseInt(days, 10), 30), // 최대 30일
  };
  
  if (isRead !== undefined) {
    options.isRead = isRead === 'true';
  }
  
  if (category) {
    options.category = category;
  }
  
  if (equipmentId) {
    options.equipmentId = parseInt(equipmentId, 10);
  }
  
  const result = await getNotifications(req.user.id, options);
  
  // 날짜별로 그룹화
  const grouped = groupByDate(result.notifications);
  
  res.json({
    notifications: result.notifications,
    grouped, // 날짜별 그룹
    totalCount: result.totalCount,
    unreadCount: result.unreadCount,
    hasMore: result.hasMore,
    pagination: {
      limit: options.limit,
      offset: options.offset,
    },
  });
}));

/**
 * GET /api/notifications/stats
 * 알림 통계
 */
router.get('/stats', auth(), asyncRoute(async (req, res) => {
  const stats = await getNotificationStats(req.user.id);
  res.json(stats);
}));

/**
 * PATCH /api/notifications/:id/read
 * 특정 알림 읽음 처리
 */
router.patch('/:id/read', auth(), asyncRoute(async (req, res) => {
  const notificationId = parseInt(req.params.id, 10);
  
  if (!notificationId) {
    return res.status(400).json({ error: '유효한 알림 ID가 필요합니다' });
  }
  
  const count = await markAsRead(req.user.id, notificationId);
  
  if (count === 0) {
    return res.status(404).json({ error: '알림을 찾을 수 없습니다' });
  }
  
  res.json({ message: '알림을 읽음 처리했습니다', count });
}));

/**
 * PATCH /api/notifications/read
 * 여러 알림 읽음 처리
 */
router.patch('/read', auth(), asyncRoute(async (req, res) => {
  const { notificationIds } = req.body;
  
  if (!Array.isArray(notificationIds) || notificationIds.length === 0) {
    return res.status(400).json({ error: '알림 ID 배열이 필요합니다' });
  }
  
  const ids = notificationIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
  
  if (ids.length === 0) {
    return res.status(400).json({ error: '유효한 알림 ID가 없습니다' });
  }
  
  const count = await markAsRead(req.user.id, ids);
  
  res.json({ message: `${count}개의 알림을 읽음 처리했습니다`, count });
}));

/**
 * PATCH /api/notifications/read-all
 * 모든 알림 읽음 처리
 */
router.patch('/read-all', auth(), asyncRoute(async (req, res) => {
  const { category, equipmentId } = req.body;
  
  const options = {};
  if (category) options.category = category;
  if (equipmentId) options.equipmentId = parseInt(equipmentId, 10);
  
  const count = await markAllAsRead(req.user.id, options);
  
  res.json({ message: `${count}개의 알림을 읽음 처리했습니다`, count });
}));

/**
 * GET /api/notifications/unread-count
 * 읽지 않은 알림 개수
 */
router.get('/unread-count', auth(), asyncRoute(async (req, res) => {
  const result = await getNotifications(req.user.id, { 
    limit: 1, 
    isRead: false 
  });
  
  res.json({ unreadCount: result.unreadCount });
}));

/**
 * 날짜별 그룹화 헬퍼 함수
 */
function groupByDate(notifications) {
  const groups = {
    today: [],
    yesterday: [],
    thisWeek: [],
    older: [],
  };
  
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const thisWeek = new Date(today);
  thisWeek.setDate(thisWeek.getDate() - 7);
  
  notifications.forEach(notification => {
    const createdAt = new Date(notification.createdAt);
    
    if (createdAt >= today) {
      groups.today.push(notification);
    } else if (createdAt >= yesterday) {
      groups.yesterday.push(notification);
    } else if (createdAt >= thisWeek) {
      groups.thisWeek.push(notification);
    } else {
      groups.older.push(notification);
    }
  });
  
  return {
    today: { label: '오늘', count: groups.today.length, items: groups.today },
    yesterday: { label: '어제', count: groups.yesterday.length, items: groups.yesterday },
    thisWeek: { label: '이번 주', count: groups.thisWeek.length, items: groups.thisWeek },
    older: { label: '이전', count: groups.older.length, items: groups.older },
  };
}

module.exports = router;