// src/server.js
require('dotenv').config()

const express = require('express')
const cors = require('cors')
const session = require('express-session')
const http = require('http')
const passport = require('passport')

// Routes 섹션에 추가
const routineRoutes = require('./routes/routines')

// Passport 설정 로드
require('./config/passport')

// WebSocket 설정
const { setupWebSocket } = require('./websocket')

// Routes
const authRoutes = require('./routes/auth')
const equipmentRoutes = require('./routes/equipment')
const favoriteRoutes = require('./routes/favorites')
const { router: waitingRoutes } = require('./routes/waiting')
const notificationRoutes = require('./routes/notifications')

// 🆕 알림 정리 서비스 import
const { cleanupOldNotifications } = require('./services/notification.service')

const app = express()
const server = http.createServer(app)
const prisma = require('./lib/prisma')

/** ===================== 운영 안전화 기본 셋업 ===================== */
app.set('trust proxy', 1) // 프록시 뒤 환경에서 Secure/SameSite 판단 정확

/** ===================== CORS (env 기반 allowlist/regex) =====================
 * .env 예)
 * CORS_ORIGINS=https://waitgym.life,https://www.waitgym.life,https://waitgym-fe-web-two.vercel.app,http://localhost:3000
 * CORS_ORIGINS_REGEX=^https:\\/\\/.*\\.vercel\\.app$
 * CORS_DEBUG=0
 */
function parseEnvList(name) {
  return (process.env[name] || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}
function parseEnvRegexList(name) {
  const raw = (process.env[name] || '').trim()
  if (!raw) return []
  return [new RegExp(raw)]
}
const allowlist = parseEnvList('CORS_ORIGINS')
const regexList = parseEnvRegexList('CORS_ORIGINS_REGEX')

function isAllowedOrigin(origin) {
  if (!origin) return true // 서버사이드/모바일 등 Origin 없는 요청 허용
  if (allowlist.includes(origin)) return true
  if (regexList.some(re => re.test(origin))) return true
  return false
}

// (옵션) CORS 디버깅
if (process.env.CORS_DEBUG === '1') {
  app.use((req, _res, next) => {
    console.log('[CORS]', { origin: req.headers.origin, method: req.method, path: req.path })
    next()
  })
}

// ✅ 라우터보다 먼저 장착
app.use(cors({
  origin(origin, cb) {
    if (isAllowedOrigin(origin)) return cb(null, true)
    return cb(new Error(`Not allowed by CORS: ${origin || 'null-origin'}`))
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  optionsSuccessStatus: 204,
  maxAge: 86400, // 프리플라이트 캐시(선택)
}))
app.options('*', cors()) // 프리플라이트 빠른 응답

/** ===================== 바디 파서 ===================== */
app.use(express.json({ limit: '1mb' }))

/** ===================== 세션/패스포트 ===================== */
// 세션(크로스도메인 쿠키)
if (!process.env.SESSION_SECRET) {
  console.warn('[server] SESSION_SECRET is not set')
}
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // HTTPS에서만 전송
    sameSite: 'none',                              // 크로스사이트 허용(프런트가 다른 도메인일 때)
    // domain: '.waitgym.life',                    // 필요 시 주석 해제
  }
}))

app.use(passport.initialize())
app.use(passport.session())

/** ===================== Health ===================== */
app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }))

/** ===================== 라우터 ===================== */
app.use('/api/auth', authRoutes)
app.use('/api/equipment', equipmentRoutes)
app.use('/api/favorites', favoriteRoutes)
app.use('/api/waiting', waitingRoutes) // 웨이팅 시스템
app.use('/api/routines', routineRoutes) //루틴
app.use('/api/notifications', notificationRoutes) //알림시스템

/** ===================== WebSocket ===================== */
setupWebSocket(server)

/** ===================== 404 & 에러 핸들러 ===================== */
app.use((req, res, _next) => {
  res.status(404).json({ error: 'Not Found', path: req.path })
})

app.use((err, req, res, _next) => {
  // CORS 차단은 403으로 명확히
  if (err && /CORS/i.test(err.message)) {
    return res.status(403).json({ error: 'CORS blocked', detail: err.message })
  }
  const status = err.status || 500
  if (process.env.NODE_ENV !== 'production') {
    console.error('[ERROR]', err)
  }
  res.status(status).json({ error: err.message || 'Server Error' })
})

/** ===================== 서버 시작 ===================== */
const PORT = Number(process.env.PORT || 4000)

// (운영 안정화) 타임아웃 보강
server.headersTimeout = 65_000
server.requestTimeout = 60_000

server.listen(PORT, () => {
  console.log(`🚀 서버가 http://localhost:${PORT} 에서 실행 중`)
  console.log(`🔌 WebSocket이 ws://localhost:${PORT}/ws 에서 실행 중`)
  console.log(`📱 실시간 알림 활성화`)

  //알림 자동 정리 작업 시작(매일 자정)
  scheduleNotificationCleanup()
})
/** ===================== 🆕 알림 자동 정리 스케줄러 ===================== */
function scheduleNotificationCleanup() {
  // 서버 시작 시 한 번 실행
  cleanupOldNotifications().catch(err => {
    console.error('[Notification Cleanup] 초기 정리 실패:', err)
  })
  
  // 매일 자정(KST 기준)에 실행
  const scheduleDaily = () => {
    const now = new Date()
    const kstOffset = 9 * 60 * 60 * 1000 // +09:00
    const kstNow = new Date(now.getTime() + kstOffset)
    
    // 다음 자정까지 남은 시간 계산
    const tomorrow = new Date(kstNow)
    tomorrow.setHours(24, 0, 0, 0)
    const msUntilMidnight = tomorrow.getTime() - kstNow.getTime()
    
    setTimeout(() => {
      cleanupOldNotifications()
        .then(count => {
          console.log(`[Notification Cleanup] ${count}개의 오래된 알림 삭제됨`)
        })
        .catch(err => {
          console.error('[Notification Cleanup] 정리 실패:', err)
        })
      
      // 다음 자정 스케줄링
      scheduleDaily()
    }, msUntilMidnight)
  }
  
  scheduleDaily()
  console.log('🧹 알림 자동 정리 스케줄러 시작 (매일 자정 KST)')
}

/** ===================== 그레이스풀 종료 ===================== */
function shutdown(signal) {
  console.log(`[${signal}] shutting down...`)
  server.close(() => {
    console.log('HTTP server closed')
    // Prisma 종료
    prisma.$disconnect().finally(() => process.exit(0))
  })
  // 10초 강제 종료 타이머
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
