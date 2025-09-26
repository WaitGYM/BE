// src/websocket.js - 향상된 버전
const WebSocket = require('ws')
const jwt = require('jsonwebtoken')

// 연결된 클라이언트 관리 (개선된 구조)
const clients = new Map() // userId -> Set<{ws, equipmentSubscriptions: Set<equipmentId>}>

// 기구별 구독자 관리
const equipmentSubscribers = new Map() // equipmentId -> Set<userId>

function registerWSClient(userId, ws) {
  // 기존 연결 정리
  if (clients.has(userId)) {
    const existingConnections = clients.get(userId)
    existingConnections.forEach(conn => {
      if (conn.ws.readyState === conn.ws.OPEN) {
        conn.ws.close(1000, 'New connection established')
      }
    })
  }

  // 새 연결 등록
  const connection = {
    ws,
    equipmentSubscriptions: new Set(),
    lastPing: Date.now(),
    isAlive: true
  }

  clients.set(userId, new Set([connection]))

  // WebSocket 이벤트 리스너 설정
  ws.on('close', () => {
    cleanupConnection(userId, connection)
  })

  ws.on('error', (error) => {
    console.error(`WebSocket error for user ${userId}:`, error)
    cleanupConnection(userId, connection)
  })

  // Ping/Pong으로 연결 상태 확인
  ws.on('pong', () => {
    connection.isAlive = true
    connection.lastPing = Date.now()
  })

  // 메시지 핸들러
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message)
      handleWebSocketMessage(userId, connection, data)
    } catch (error) {
      console.error('WebSocket message parse error:', error)
      ws.send(JSON.stringify({ 
        type: 'error', 
        message: 'Invalid JSON format' 
      }))
    }
  })
}

function cleanupConnection(userId, connection) {
  // 기구 구독 해제
  connection.equipmentSubscriptions.forEach(equipmentId => {
    unsubscribeFromEquipment(userId, equipmentId)
  })

  // 클라이언트 목록에서 제거
  const userConnections = clients.get(userId)
  if (userConnections) {
    userConnections.delete(connection)
    if (userConnections.size === 0) {
      clients.delete(userId)
    }
  }
}

function handleWebSocketMessage(userId, connection, data) {
  switch (data.type) {
    case 'subscribe_equipment':
      if (data.equipmentId) {
        subscribeToEquipment(userId, data.equipmentId, connection)
        connection.ws.send(JSON.stringify({
          type: 'subscription_confirmed',
          equipmentId: data.equipmentId,
          message: `기구 ${data.equipmentId} 실시간 업데이트 구독됨`
        }))
      }
      break

    case 'unsubscribe_equipment':
      if (data.equipmentId) {
        unsubscribeFromEquipment(userId, data.equipmentId, connection)
        connection.ws.send(JSON.stringify({
          type: 'subscription_cancelled',
          equipmentId: data.equipmentId,
          message: `기구 ${data.equipmentId} 구독 해제됨`
        }))
      }
      break

    case 'ping':
      connection.ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }))
      break

    case 'request_status':
      // 특정 기구 상태 요청
      if (data.equipmentId) {
        // 여기서 실시간 상태를 조회해서 바로 전송할 수 있음
        sendEquipmentStatus(userId, data.equipmentId)
      }
      break

    default:
      connection.ws.send(JSON.stringify({
        type: 'error',
        message: `Unknown message type: ${data.type}`
      }))
  }
}

function subscribeToEquipment(userId, equipmentId, connection) {
  // 사용자 연결에 구독 추가
  connection.equipmentSubscriptions.add(equipmentId)

  // 기구별 구독자 목록에 추가
  if (!equipmentSubscribers.has(equipmentId)) {
    equipmentSubscribers.set(equipmentId, new Set())
  }
  equipmentSubscribers.get(equipmentId).add(userId)
}

function unsubscribeFromEquipment(userId, equipmentId, connection = null) {
  // 특정 연결에서만 해제하거나 모든 연결에서 해제
  if (connection) {
    connection.equipmentSubscriptions.delete(equipmentId)
  } else {
    // 모든 사용자 연결에서 해제
    const userConnections = clients.get(userId)
    if (userConnections) {
      userConnections.forEach(conn => {
        conn.equipmentSubscriptions.delete(equipmentId)
      })
    }
  }

  // 기구별 구독자 목록에서 제거
  const subscribers = equipmentSubscribers.get(equipmentId)
  if (subscribers) {
    subscribers.delete(userId)
    if (subscribers.size === 0) {
      equipmentSubscribers.delete(equipmentId)
    }
  }
}

// 특정 사용자에게 알림 전송 (기존 함수 개선)
function sendNotification(userId, payload) {
  const userConnections = clients.get(userId)
  if (!userConnections || userConnections.size === 0) return false

  const message = JSON.stringify({ 
    type: 'notification', 
    timestamp: new Date().toISOString(),
    ...payload 
  })

  let sentCount = 0
  userConnections.forEach(connection => {
    if (connection.ws.readyState === connection.ws.OPEN) {
      connection.ws.send(message)
      sentCount++
    }
  })

  return sentCount > 0
}

// 기구별 구독자들에게 브로드캐스트
function broadcastToEquipmentSubscribers(equipmentId, payload) {
  const subscribers = equipmentSubscribers.get(equipmentId)
  if (!subscribers || subscribers.size === 0) return 0

  const message = JSON.stringify({
    type: 'equipment_update',
    equipmentId,
    timestamp: new Date().toISOString(),
    ...payload
  })

  let sentCount = 0
  subscribers.forEach(userId => {
    const userConnections = clients.get(userId)
    if (userConnections) {
      userConnections.forEach(connection => {
        // 해당 기구를 구독 중인 연결만 전송
        if (connection.equipmentSubscriptions.has(equipmentId) && 
            connection.ws.readyState === connection.ws.OPEN) {
          connection.ws.send(message)
          sentCount++
        }
      })
    }
  })

  return sentCount
}

// 실시간 ETA 업데이트 브로드캐스트
function broadcastETAUpdate(equipmentId, etaData) {
  return broadcastToEquipmentSubscribers(equipmentId, {
    type: 'eta_updated',
    data: etaData
  })
}

// 기구 상태 변경 브로드캐스트 (개선됨)
function broadcastEquipmentStatusChange(equipmentId, statusData) {
  return broadcastToEquipmentSubscribers(equipmentId, {
    type: 'status_changed',
    data: statusData
  })
}

// 🆕 운동 완료 브로드캐스트 (특별 처리)
function broadcastWorkoutCompletion(equipmentId, completionData) {
  const message = {
    type: 'workout_completed',
    equipmentId,
    data: {
      ...completionData,
      showCompletionBadge: true, // 프론트엔드에서 완료 배지 표시 플래그
      completionDisplayDuration: 300000, // 5분간 표시
    }
  }

  // 해당 기구 구독자들에게 브로드캐스트
  const broadcastCount = broadcastToEquipmentSubscribers(equipmentId, message)

  // 🎉 완료자에게 축하 메시지
  sendNotification(completionData.userId, {
    type: 'WORKOUT_COMPLETED',
    title: '🎉 운동 완료!',
    message: `${completionData.equipmentName} ${completionData.completedSets}/${completionData.totalSets} 세트 완료`,
    equipmentId,
    completionData,
    celebrationEmoji: completionData.wasFullyCompleted ? '🎉' : '👍'
  })

  return broadcastCount
}

// 연결 상태 모니터링 (Ping/Pong)
function startHealthCheck() {
  setInterval(() => {
    clients.forEach((connections, userId) => {
      connections.forEach(connection => {
        if (!connection.isAlive) {
          console.log(`Terminating dead connection for user ${userId}`)
          connection.ws.terminate()
          return
        }

        // 5분 이상 응답이 없으면 연결 종료
        if (Date.now() - connection.lastPing > 5 * 60 * 1000) {
          console.log(`Terminating inactive connection for user ${userId}`)
          connection.ws.terminate()
          return
        }

        connection.isAlive = false
        connection.ws.ping()
      })
    })
  }, 30000) // 30초마다 체크
}

// 통계 정보 조회
function getWebSocketStats() {
  const totalConnections = Array.from(clients.values())
    .reduce((sum, connections) => sum + connections.size, 0)

  const equipmentSubscriptionStats = Array.from(equipmentSubscribers.entries())
    .map(([equipmentId, subscribers]) => ({
      equipmentId,
      subscriberCount: subscribers.size
    }))

  return {
    totalUsers: clients.size,
    totalConnections,
    equipmentSubscriptions: equipmentSubscriptionStats,
    timestamp: new Date().toISOString()
  }
}

// WebSocket 서버 설정 (개선된 버전)
function setupWebSocket(server) {
  const wss = new WebSocket.Server({ 
    server, 
    path: '/ws',
    clientTracking: true // 클라이언트 추적 활성화
  })

  wss.on('connection', (ws, req) => {
    console.log(`New WebSocket connection from ${req.socket.remoteAddress}`)
    
    // 초기 인증 대기 (30초 타임아웃)
    const authTimeout = setTimeout(() => {
      if (!ws.userId) {
        ws.close(4001, 'Authentication timeout')
      }
    }, 30000)

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message)
        
        if (data.type === 'auth' && data.token) {
          clearTimeout(authTimeout)
          
          try {
            const payload = jwt.verify(data.token, process.env.JWT_SECRET)
            ws.userId = payload.id
            registerWSClient(ws.userId, ws)
            
            ws.send(JSON.stringify({ 
              type: 'auth_success', 
              message: '실시간 알림 연결 완료',
              userId: ws.userId,
              timestamp: new Date().toISOString()
            }))
            
            console.log(`User ${ws.userId} authenticated successfully`)
          } catch (error) {
            console.error('JWT verification failed:', error)
            ws.send(JSON.stringify({ 
              type: 'auth_failed', 
              message: 'Invalid token' 
            }))
            ws.close(4002, 'Invalid token')
          }
        } else if (ws.userId) {
          // 인증된 사용자의 메시지 처리
          const userConnections = clients.get(ws.userId)
          const connection = Array.from(userConnections || [])
            .find(conn => conn.ws === ws)
          
          if (connection) {
            handleWebSocketMessage(ws.userId, connection, data)
          }
        } else {
          ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Not authenticated' 
          }))
        }
      } catch (error) {
        console.error('WebSocket message error:', error)
        ws.send(JSON.stringify({ 
          type: 'error', 
          message: 'Message processing failed' 
        }))
      }
    })

    ws.on('close', (code, reason) => {
      clearTimeout(authTimeout)
      console.log(`WebSocket closed: ${code} - ${reason}`)
    })

    ws.on('error', (error) => {
      console.error('WebSocket error:', error)
      clearTimeout(authTimeout)
    })
  })

  // 연결 상태 모니터링 시작
  startHealthCheck()

  console.log('WebSocket server setup complete with enhanced features')
  
  return wss
}

module.exports = { 
  setupWebSocket, 
  sendNotification,
  broadcastETAUpdate,
  broadcastEquipmentStatusChange,
  broadcastWorkoutCompletion, // 🆕 추가
  getWebSocketStats,
  equipmentSubscribers // 디버깅용 export
}