require('dotenv').config()
const express = require('express')
const cors = require('cors')
const session = require('express-session')
const { PrismaClient } = require('@prisma/client')
const { createServer } = require('http')

// Passport 설정 import
require('./config/passport')

// WebSocket 및 알림 서비스
const { createSocketServer } = require('./websocket/socketServer')
const notificationService = require('./services/notificationService')

const authRoutes = require('./routes/auth')
const equipmentRoutes = require('./routes/equipment')
const reservationRoutes = require('./routes/reservations')

const app = express()
const server = createServer(app)  // HTTP 서버 생성
const prisma = new PrismaClient()

// WebSocket 서버 생성 및 알림 서비스에 연결
const io = createSocketServer(server)
notificationService.setSocketIO(io)

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}))
app.use(express.json())

// 세션 설정
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 // 24시간
  }
}))

// Passport 초기화
const passport = require('passport')
app.use(passport.initialize())
app.use(passport.session())

// 알림 서비스를 req에 추가 (라우트에서 사용할 수 있도록)
app.use((req, res, next) => {
  req.notificationService = notificationService
  next()
})

// 기본 헬스 체크
app.get('/health', (_, res) => res.json({ 
  ok: true, 
  time: new Date().toISOString(),
  version: '1.0.0',
  websocket: 'enabled'
}))

// API 라우트들
app.use('/api/auth', authRoutes)
app.use('/api/equipment', equipmentRoutes)
app.use('/api/reservations', reservationRoutes)

// WebSocket 상태 확인 엔드포인트
app.get('/api/websocket/status', (req, res) => {
  const connectedClients = io.sockets.sockets.size
  res.json({
    enabled: true,
    connectedClients,
    rooms: Object.keys(io.sockets.adapter.rooms)
  })
})

// 시스템 공지 전송 (관리자용 - 개발환경에서만)
if (process.env.NODE_ENV === 'development') {
  app.post('/api/websocket/announce', (req, res) => {
    const { message, type } = req.body
    notificationService.notifySystemMessage(message, type || 'INFO')
    res.json({ success: true, message: '공지사항이 전송되었습니다' })
  })
}

// API 문서용 엔드포인트 (개발환경에서만)
if (process.env.NODE_ENV === 'development') {
  app.get('/api', (req, res) => {
    res.json({
      message: 'Gym Reservation API with WebSocket',
      version: '1.0.0',
      websocket: {
        enabled: true,
        endpoint: '/socket.io/',
        events: {
          client_to_server: [
            'join_equipment_room',
            'leave_equipment_room'
          ],
          server_to_client: [
            'connection_status',
            'new_reservation',
            'reservation_cancelled',
            'reservation_upcoming',
            'system_notification',
            'equipment_updated',
            'equipment_status_changed',
            'reservation_update'
          ]
        }
      },
      endpoints: {
        auth: {
          'POST /api/auth/google': '구글 로그인 시작',
          'GET /api/auth/google/callback': '구글 로그인 콜백',
          'GET /api/auth/me': '현재 사용자 정보',
          'POST /api/auth/logout': '로그아웃'
        },
        equipment: {
          'GET /api/equipment': '장비 목록',
          'GET /api/equipment/:id': '장비 상세',
          'GET /api/equipment/popular/ranking': '인기 장비',
          'GET /api/equipment/search/:query': '장비 검색',
          'POST /api/equipment': '장비 생성 (관리자)',
          'PUT /api/equipment/:id': '장비 수정 (관리자)',
          'DELETE /api/equipment/:id': '장비 삭제 (관리자)'
        },
        reservations: {
          'GET /api/reservations/me': '내 예약 목록',
          'GET /api/reservations/today': '오늘의 예약',
          'GET /api/reservations/availability': '예약 가능 시간',
          'POST /api/reservations': '예약 생성',
          'PUT /api/reservations/:id': '예약 수정',
          'DELETE /api/reservations/:id': '예약 삭제'
        },
        websocket: {
          'GET /api/websocket/status': 'WebSocket 상태 확인',
          'POST /api/websocket/announce': '시스템 공지 (개발용)'
        }
      }
    })
  })
}

// 404 핸들러
app.use((req, res, next) => {
  res.status(404).json({ 
    error: 'Not Found',
    message: `경로 ${req.method} ${req.path}를 찾을 수 없습니다`,
    availableEndpoints: '/api'
  })
})

// 전역 에러 핸들러
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Error:`, err)
  
  // Prisma 에러 처리
  if (err.code === 'P2002') {
    return res.status(409).json({ 
      error: '중복된 데이터입니다',
      details: err.meta
    })
  }
  
  if (err.code === 'P2025') {
    return res.status(404).json({ 
      error: '데이터를 찾을 수 없습니다' 
    })
  }
  
  // JWT 에러 처리
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ 
      error: '유효하지 않은 토큰입니다' 
    })
  }
  
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ 
      error: '토큰이 만료되었습니다' 
    })
  }
  
  // 기본 에러 처리
  res.status(err.status || 500).json({ 
    error: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  })
})

const port = process.env.PORT || 4000
server.listen(port, () => {  // app.listen 대신 server.listen 사용
  console.log(`🚀 API Server running on http://localhost:${port}`)
  console.log(`🔗 WebSocket Server enabled on ws://localhost:${port}`)
  console.log(`📋 API Documentation: http://localhost:${port}/api`)
  console.log(`❤️  Health Check: http://localhost:${port}/health`)
})