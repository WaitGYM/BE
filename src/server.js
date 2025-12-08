// src/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const http = require('http');
const passport = require('passport');

// 🔥 이벤트 버스를 가장 먼저 로드 (순환 참조 방지)
const eventBus = require('./events/eventBus');

// Passport 설정 로드
require('./config/passport');

// WebSocket 설정
const { setupWebSocket } = require('./websocket');

// Routes
const authRoutes = require('./routes/auth');
const equipmentRoutes = require('./routes/equipment');
const favoriteRoutes = require('./routes/favorites');
const { router: waitingRoutes } = require('./routes/waiting');
const routineRoutes = require('./routes/routines');
const notificationRoutes = require('./routes/notifications');

// 알림 정리 서비스
const { cleanupOldNotifications } = require('./services/notification.service');

const app = express();
const server = http.createServer(app);
const prisma = require('./lib/prisma');

/** ===================== 운영 안전화 기본 셋업 ===================== */
app.set('trust proxy', 1);

/** ===================== CORS 설정 ===================== */
function parseEnvList(name) {
  return (process.env[name] || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function parseEnvRegexList(name) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return [];
  return [new RegExp(raw)];
}

const allowlist = parseEnvList('CORS_ORIGINS');
const regexList = parseEnvRegexList('CORS_ORIGINS_REGEX');

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (allowlist.includes(origin)) return true;
  if (regexList.some(re => re.test(origin))) return true;
  return false;
}

if (process.env.CORS_DEBUG === '1') {
  app.use((req, _res, next) => {
    console.log('[CORS]', { origin: req.headers.origin, method: req.method, path: req.path });
    next();
  });
}

app.use(cors({
  origin(origin, cb) {
    if (isAllowedOrigin(origin)) return cb(null, true);
    return cb(new Error(`Not allowed by CORS: ${origin || 'null-origin'}`));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  optionsSuccessStatus: 204,
  maxAge: 86400,
}));

app.options('*', cors());

/** ===================== 바디 파서 ===================== */
app.use(express.json({ limit: '1mb' }));

/** ===================== 세션/패스포트 ===================== */
if (!process.env.SESSION_SECRET) {
  console.warn('[server] SESSION_SECRET is not set');
}

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'none',
  }
}));

app.use(passport.initialize());
app.use(passport.session());

/** ===================== Health ===================== */
app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/** ===================== 라우터 ===================== */
app.use('/api/auth', authRoutes);
app.use('/api/equipment', equipmentRoutes);
app.use('/api/favorites', favoriteRoutes);
app.use('/api/waiting', waitingRoutes);
app.use('/api/routines', routineRoutes);
app.use('/api/notifications', notificationRoutes);

/** ===================== WebSocket ===================== */
setupWebSocket(server);

/** ===================== 404 & 에러 핸들러 ===================== */
app.use((req, res, _next) => {
  res.status(404).json({ error: 'Not Found', path: req.path });
});

app.use((err, req, res, _next) => {
  if (err && /CORS/i.test(err.message)) {
    return res.status(403).json({ error: 'CORS blocked', detail: err.message });
  }
  const status = err.status || 500;
  if (process.env.NODE_ENV !== 'production') {
    console.error('[ERROR]', err);
  }
  res.status(status).json({ error: err.message || 'Server Error' });
});

/** ===================== 서버 시작 ===================== */
const PORT = Number(process.env.PORT || 4000);

server.headersTimeout = 65_000;
server.requestTimeout = 60_000;

server.listen(PORT, () => {
  console.log(`🚀 서버가 http://localhost:${PORT} 에서 실행 중`);
  console.log(`🔌 WebSocket이 ws://localhost:${PORT}/ws 에서 실행 중`);
  console.log(`📱 실시간 알림 활성화`);
  console.log(`✅ 이벤트 버스 패턴 적용 완료 - 순환 참조 해결됨`);
  
  // 알림 자동 정리 작업 시작
  //scheduleNotificationCleanup();
});

/** ===================== 알림 자동 정리 스케줄러 ===================== */
function scheduleNotificationCleanup() {
  cleanupOldNotifications().catch(err => {
    console.error('[Notification Cleanup] 초기 정리 실패:', err);
  });

  const scheduleDaily = () => {
    const now = new Date();
    const kstOffset = 9 * 60 * 60 * 1000;
    const kstNow = new Date(now.getTime() + kstOffset);
    
    const tomorrow = new Date(kstNow);
    tomorrow.setHours(24, 0, 0, 0);
    const msUntilMidnight = tomorrow.getTime() - kstNow.getTime();

    setTimeout(() => {
      cleanupOldNotifications()
        .then(count => {
          console.log(`[Notification Cleanup] ${count}개의 오래된 알림 삭제됨`);
        })
        .catch(err => {
          console.error('[Notification Cleanup] 정리 실패:', err);
        });
      
      scheduleDaily();
    }, msUntilMidnight);
  };

  scheduleDaily();
  console.log('🧹 알림 자동 정리 스케줄러 시작 (매일 자정 KST)');
}

/** ===================== 그레이스풀 종료 ===================== */
function shutdown(signal) {
  console.log(`[${signal}] shutting down...`);
  server.close(() => {
    console.log('HTTP server closed');
    prisma.$disconnect().finally(() => process.exit(0));
  });
  
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));