let io = null

// Socket.IO 인스턴스 설정
function setSocketIO(socketInstance) {
  io = socketInstance
}

// 새 예약 알림
function notifyNewReservation(reservation, equipment, user) {
  if (!io) return

  console.log('📢 새 예약 알림 발송:', reservation.id)

  // 관리자들에게 알림
  io.to('admins').emit('new_reservation', {
    type: 'NEW_RESERVATION',
    message: `${user.name}님이 ${equipment.name}을 예약했습니다`,
    reservation: {
      id: reservation.id,
      startAt: reservation.startAt,
      endAt: reservation.endAt,
      equipment: equipment,
      user: {
        id: user.id,
        name: user.name,
        email: user.email
      }
    },
    timestamp: new Date().toISOString()
  })

  // 해당 장비를 보고 있는 사용자들에게 예약 현황 업데이트
  io.to(`equipment_${equipment.id}`).emit('equipment_updated', {
    type: 'EQUIPMENT_RESERVATION_ADDED',
    equipmentId: equipment.id,
    reservation: {
      id: reservation.id,
      startAt: reservation.startAt,
      endAt: reservation.endAt,
      status: reservation.status
    }
  })

  // 예약한 사용자에게 확인 알림
  io.to(`user_${user.id}`).emit('reservation_confirmed', {
    type: 'RESERVATION_CONFIRMED',
    message: `${equipment.name} 예약이 확정되었습니다`,
    reservation: {
      id: reservation.id,
      startAt: reservation.startAt,
      endAt: reservation.endAt,
      equipment: equipment
    }
  })
}

// 예약 취소 알림
function notifyReservationCancelled(reservation, equipment, user) {
  if (!io) return

  console.log('🚫 예약 취소 알림 발송:', reservation.id)

  // 관리자들에게 알림
  io.to('admins').emit('reservation_cancelled', {
    type: 'RESERVATION_CANCELLED',
    message: `${user.name}님이 ${equipment.name} 예약을 취소했습니다`,
    reservation: {
      id: reservation.id,
      startAt: reservation.startAt,
      endAt: reservation.endAt,
      equipment: equipment,
      user: {
        id: user.id,
        name: user.name,
        email: user.email
      }
    },
    timestamp: new Date().toISOString()
  })

  // 해당 장비를 보고 있는 사용자들에게 업데이트
  io.to(`equipment_${equipment.id}`).emit('equipment_updated', {
    type: 'EQUIPMENT_RESERVATION_REMOVED',
    equipmentId: equipment.id,
    reservationId: reservation.id
  })

  // 취소한 사용자에게 확인 알림
  io.to(`user_${user.id}`).emit('reservation_cancelled_confirm', {
    type: 'RESERVATION_CANCELLED',
    message: `${equipment.name} 예약이 취소되었습니다`,
    reservationId: reservation.id
  })
}

// 예약 시간 임박 알림 (예약 시작 30분 전)
function notifyUpcomingReservation(reservation, equipment, user) {
  if (!io) return

  console.log('⏰ 예약 임박 알림 발송:', reservation.id)

  io.to(`user_${user.id}`).emit('reservation_upcoming', {
    type: 'RESERVATION_UPCOMING',
    message: `${equipment.name} 예약이 30분 후 시작됩니다`,
    reservation: {
      id: reservation.id,
      startAt: reservation.startAt,
      endAt: reservation.endAt,
      equipment: equipment
    },
    timestamp: new Date().toISOString()
  })
}

// 시스템 공지 (모든 사용자)
function notifySystemMessage(message, type = 'INFO') {
  if (!io) return

  console.log('📢 시스템 공지:', message)

  io.to('all_users').emit('system_notification', {
    type: 'SYSTEM_MESSAGE',
    level: type,
    message: message,
    timestamp: new Date().toISOString()
  })
}

// 장비 상태 변경 알림
function notifyEquipmentStatus(equipmentId, equipmentName, status, message) {
  if (!io) return

  console.log('🔧 장비 상태 변경:', equipmentName, status)

  // 해당 장비를 보고 있는 사용자들에게 알림
  io.to(`equipment_${equipmentId}`).emit('equipment_status_changed', {
    type: 'EQUIPMENT_STATUS_CHANGED',
    equipmentId: equipmentId,
    equipmentName: equipmentName,
    status: status,
    message: message,
    timestamp: new Date().toISOString()
  })

  // 관리자들에게도 알림
  io.to('admins').emit('equipment_status_changed', {
    type: 'EQUIPMENT_STATUS_CHANGED',
    equipmentId: equipmentId,
    equipmentName: equipmentName,
    status: status,
    message: message,
    timestamp: new Date().toISOString()
  })
}

// 실시간 예약 현황 전송
function broadcastReservationUpdate(equipmentId, reservations) {
  if (!io) return

  io.to(`equipment_${equipmentId}`).emit('reservation_update', {
    type: 'RESERVATION_UPDATE',
    equipmentId: equipmentId,
    reservations: reservations,
    timestamp: new Date().toISOString()
  })
}

module.exports = {
  setSocketIO,
  notifyNewReservation,
  notifyReservationCancelled,
  notifyUpcomingReservation,
  notifySystemMessage,
  notifyEquipmentStatus,
  broadcastReservationUpdate
}