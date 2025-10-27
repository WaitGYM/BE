// src/events/eventBus.js
const EventEmitter = require('events');

class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50); // 리스너 제한 증가
  }

  // 타입 안전성을 위한 헬퍼 메서드들
  emitNotification(userId, payload) {
    this.emit('notification:send', { userId, payload });
  }

  emitEquipmentStatusChange(equipmentId, data) {
    this.emit('equipment:status_change', { equipmentId, data });
  }

  emitETAUpdate(equipmentId, data) {
    this.emit('equipment:eta_update', { equipmentId, data });
  }

  emitWorkoutCompletion(equipmentId, data) {
    this.emit('equipment:workout_completed', { equipmentId, data });
  }

  // 이벤트 리스너 등록 헬퍼
  onNotificationSend(handler) {
    this.on('notification:send', handler);
  }

  onEquipmentStatusChange(handler) {
    this.on('equipment:status_change', handler);
  }

  onETAUpdate(handler) {
    this.on('equipment:eta_update', handler);
  }

  onWorkoutCompletion(handler) {
    this.on('equipment:workout_completed', handler);
  }
}

// 싱글톤 인스턴스 생성
const eventBus = new EventBus();

module.exports = eventBus;