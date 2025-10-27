// src/services/notification.service.js
const prisma = require('../lib/prisma');
const eventBus = require('../events/eventBus');

/**
 * 알림 타입별 카테고리 매핑
 */
const NOTIFICATION_CATEGORIES = {
  // 대기열 관련
  EQUIPMENT_AVAILABLE: 'queue',
  QUEUE_CANCELLED_CONFIRMATION: 'queue',
  QUEUE_EXPIRED: 'queue',
  
  // 운동 관련
  REST_STARTED: 'workout',
  NEXT_SET_STARTED: 'workout',
  REST_SKIPPED: 'workout',
  EXERCISE_STOPPED: 'workout',
  WORKOUT_COMPLETED: 'workout',
  
  // ETA/대기자 수 관련
  AUTO_ETA_UPDATE: 'eta',
  ETA_UPDATED: 'eta',
  WAITING_COUNT: 'eta',
};

/**
 * 알림 우선순위 (높을수록 중요)
 */
const NOTIFICATION_PRIORITY = {
  EQUIPMENT_AVAILABLE: 10,
  WORKOUT_COMPLETED: 9,
  QUEUE_EXPIRED: 8,
  EXERCISE_STOPPED: 7,
  REST_STARTED: 6,
  NEXT_SET_STARTED: 5,
  WAITING_COUNT: 4,
  ETA_UPDATED: 3,
  AUTO_ETA_UPDATE: 2,
  QUEUE_CANCELLED_CONFIRMATION: 6,
  REST_SKIPPED: 5,
};

/**
 * 알림을 DB에 저장
 */
async function saveNotification(userId, payload) {
  try {
    const category = NOTIFICATION_CATEGORIES[payload.type] || 'other';
    const priority = NOTIFICATION_PRIORITY[payload.type] || 5;

    // 메타데이터 정리 (title, message, type 제외한 나머지)
    const { type, title, message, equipmentId, equipmentName, queueId, ...metadata } = payload;

    const notification = await prisma.notification.create({
      data: {
        userId,
        type: payload.type,
        title: payload.title || '알림',
        message: payload.message || '',
        equipmentId: payload.equipmentId || null,
        equipmentName: payload.equipmentName || null,
        queueId: payload.queueId || null,
        usageId: payload.usageId || null,
        category,
        priority,
        metadata: Object.keys(metadata).length > 0 ? metadata : null,
      },
    });

    return notification;
  } catch (error) {
    console.error('알림 저장 실패:', error);
    return null;
  }
}

/**
 * 사용자 알림 목록 조회
 */
async function getNotifications(userId, options = {}) {
  const {
    limit = 50,
    offset = 0,
    isRead = undefined,
    category = undefined,
    days = 30,
    equipmentId = undefined,
  } = options;

  const where = { userId };

  // 읽음/안읽음 필터
  if (isRead !== undefined) {
    where.isRead = isRead;
  }

  // 카테고리 필터
  if (category) {
    where.category = category;
  }

  // 기구 필터
  if (equipmentId) {
    where.equipmentId = equipmentId;
  }

  // 날짜 필터 (최대 30일)
  const maxDays = Math.min(days, 30);
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - maxDays);
  where.createdAt = { gte: startDate };

  const [notifications, totalCount, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: [
        { isRead: 'asc' }, // 안읽은 것 먼저
        { priority: 'desc' }, // 우선순위 높은 것 먼저
        { createdAt: 'desc' }, // 최신순
      ],
      take: limit,
      skip: offset,
      include: {
        equipment: {
          select: { id: true, name: true, category: true, imageUrl: true },
        },
      },
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { ...where, isRead: false } }),
  ]);

  return {
    notifications,
    totalCount,
    unreadCount,
    hasMore: offset + limit < totalCount,
  };
}

/**
 * 알림 읽음 처리
 */
async function markAsRead(userId, notificationIds) {
  const ids = Array.isArray(notificationIds) ? notificationIds : [notificationIds];

  const result = await prisma.notification.updateMany({
    where: {
      id: { in: ids },
      userId, // 본인 알림만 수정 가능
    },
    data: {
      isRead: true,
      readAt: new Date(),
    },
  });

  return result.count;
}

/**
 * 모든 알림 읽음 처리
 */
async function markAllAsRead(userId, options = {}) {
  const { category, equipmentId } = options;

  const where = { userId, isRead: false };
  if (category) where.category = category;
  if (equipmentId) where.equipmentId = equipmentId;

  const result = await prisma.notification.updateMany({
    where,
    data: {
      isRead: true,
      readAt: new Date(),
    },
  });

  return result.count;
}

/**
 * 알림 삭제 (30일 이상 된 읽은 알림 자동 삭제)
 */
async function cleanupOldNotifications() {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const result = await prisma.notification.deleteMany({
    where: {
      isRead: true,
      createdAt: { lt: thirtyDaysAgo },
    },
  });

  console.log(`${result.count}개의 오래된 알림 삭제됨`);
  return result.count;
}

/**
 * 알림 통계
 */
async function getNotificationStats(userId) {
  const [totalCount, unreadCount, categoryStats] = await Promise.all([
    prisma.notification.count({ where: { userId } }),
    prisma.notification.count({ where: { userId, isRead: false } }),
    prisma.notification.groupBy({
      by: ['category'],
      where: { userId },
      _count: { id: true },
    }),
  ]);

  return {
    totalCount,
    unreadCount,
    categories: categoryStats.map(stat => ({
      category: stat.category,
      count: stat._count.id,
    })),
  };
}

/**
 * 알림 전송 + DB 저장 (이벤트 버스 사용)
 * WebSocket 의존성 제거 - 이벤트로 발행만 함
 */
async function sendAndSaveNotification(userId, payload) {
  // 1. DB에 저장
  await saveNotification(userId, payload);
  
  // 2. 이벤트 발행 (WebSocket은 이벤트를 구독해서 처리)
  eventBus.emitNotification(userId, payload);
  
  return true;
}

module.exports = {
  saveNotification,
  sendAndSaveNotification,
  getNotifications,
  markAsRead,
  markAllAsRead,
  cleanupOldNotifications,
  getNotificationStats,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_PRIORITY,
};