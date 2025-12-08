// src/services/notification.service.js
const prisma = require('../lib/prisma');
const eventBus = require('../events/eventBus');

/**
 * 알림 타입별 카테고리 매핑 (3가지만)
 */
const NOTIFICATION_CATEGORIES = {
  // 사용 가능 알림
  EQUIPMENT_AVAILABLE: 'queue',
  
  // 대기 만료 알림
  QUEUE_EXPIRED: 'queue',
  
  // 대기자 수 알림
  WAITING_COUNT: 'eta',
};

/**
 * 알림 우선순위 (높을수록 중요)
 */
const NOTIFICATION_PRIORITY = {
  EQUIPMENT_AVAILABLE: 10,      // 가장 중요
  QUEUE_EXPIRED: 8,
  WAITING_COUNT: 4,
};

/**
 * 알림을 DB에 저장 (3가지 타입만 저장)
 */
async function saveNotification(userId, payload) {
  try {
    // 허용된 타입이 아니면 저장하지 않음
    if (!NOTIFICATION_CATEGORIES[payload.type]) {
      console.log(`[Notification] Skipped saving non-allowed type: ${payload.type}`);
      return null;
    }

    const category = NOTIFICATION_CATEGORIES[payload.type];
    const priority = NOTIFICATION_PRIORITY[payload.type] || 5;

    // 메타데이터 정리
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
        { isRead: 'asc' },        // 안읽은 것 먼저
        { createdAt: 'desc' },    // 최신순
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
  // TODO: 나중에 Prisma 로직 안정화되면 다시 구현
  console.log('[Notification Cleanup] 비활성화 상태 - 아무 작업도 하지 않음');
  return 0;
  
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
 * 3가지 타입만 저장, 나머지는 WebSocket으로만 전송
 */
async function sendAndSaveNotification(userId, payload) {
  // 1. 허용된 타입만 DB에 저장
  if (NOTIFICATION_CATEGORIES[payload.type]) {
    await saveNotification(userId, payload);
  }
  
  // 2. 모든 타입의 알림은 WebSocket으로 전송 (이벤트 발행)
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