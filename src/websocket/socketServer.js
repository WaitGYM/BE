const { Server } = require('socket.io')
const jwt = require('jsonwebtoken')

function createSocketServer(server) {
  const io = new Server(server, {
    cors: {
      origin: process.env.FRONTEND_URL || "http://localhost:3000",
      methods: ["GET", "POST"],
      credentials: true
    }
  })

  // JWT 토큰 인증 미들웨어
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token
      if (!token) {
        return next(new Error('토큰이 필요합니다'))
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET)
      socket.userId = decoded.id
      socket.userRole = decoded.role
      socket.userEmail = decoded.email
      
      console.log(`사용자 연결: ${decoded.email} (ID: ${decoded.id})`)
      next()
    } catch (err) {
      console.log('WebSocket 인증 실패:', err.message)
      next(new Error('인증 실패'))
    }
  })

  io.on('connection', (socket) => {
    console.log(`✅ WebSocket 연결: ${socket.userEmail}`)

    // 사용자를 자신의 방에 참여시키기 (개인 알림용)
    socket.join(`user_${socket.userId}`)
    
    // 관리자면 관리자 방에도 참여
    if (socket.userRole === 'ADMIN') {
      socket.join('admins')
    }

    // 모든 사용자는 전체 방에 참여 (시스템 공지용)
    socket.join('all_users')

    // 연결된 사용자 수 전송
    socket.emit('connection_status', {
      connected: true,
      userId: socket.userId,
      role: socket.userRole
    })

    // 클라이언트에서 실시간 예약 현황 요청
    socket.on('join_equipment_room', (equipmentId) => {
      socket.join(`equipment_${equipmentId}`)
      console.log(`사용자 ${socket.userEmail}이 장비 ${equipmentId} 방에 참여`)
    })

    socket.on('leave_equipment_room', (equipmentId) => {
      socket.leave(`equipment_${equipmentId}`)
      console.log(`사용자 ${socket.userEmail}이 장비 ${equipmentId} 방에서 나감`)
    })

    // 연결 해제
    socket.on('disconnect', () => {
      console.log(`❌ WebSocket 연결 해제: ${socket.userEmail}`)
    })
  })

  return io
}

module.exports = { createSocketServer }