require('dotenv').config()
const express = require('express')
const cors = require('cors')
const session = require('express-session')
const { PrismaClient } = require('@prisma/client')

// Passport 설정 import
require('./config/passport')

const authRoutes = require('./routes/auth')
const equipmentRoutes = require('./routes/equipment')
const reservationRoutes = require('./routes/reservations')
const favoriteRoutes = require('./routes/favorites')

const app = express()
const prisma = new PrismaClient()

// Nginx 뒤에서 secure 쿠키 인식
app.set('trust proxy', 1)

// 3) CORS: 프론트 도메인 + 크리덴셜 허용
app.use(cors({
  origin: (origin, cb) => {
    const allow = [
      'https://waitgym.life',
      'https://www.waitgym.life',
      'https://waitgym-fe-web-two.vercel.app'
    ];
    // vercel 프리뷰 허용이 필요하면 아래 줄 추가:
    // if (origin && new URL(origin).host.endsWith('.vercel.app')) return cb(null, true);

    if (!origin || allow.includes(origin)) return cb(null, true);
    return cb(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.options('*', cors()); // 4) 프리플라이트 빠른 응답
app.use(express.json());

// 5) 세션(크로스도메인 쿠키 세팅 필수)
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // HTTPS에서만 전송
    sameSite: 'none',                               // 크로스사이트 허용
    // domain: '.waitgym.life',                    // 필요 시 주석 해제
  }
}));

// Passport 초기화
const passport = require('passport')
app.use(passport.initialize())
app.use(passport.session())

app.get('/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }))

app.use('/api/auth', authRoutes)
app.use('/api/equipment', equipmentRoutes)
app.use('/api/reservations', reservationRoutes)
app.use('/api/favorites', favoriteRoutes)

// 404
app.use((req, res, next) => {
  res.status(404).json({ error: 'Not Found' })
})

// Error handler
app.use((err, req, res, next) => {
  console.error(err)
  res.status(err.status || 500).json({ error: err.message || 'Server Error' })
})

const port = process.env.PORT || 4000
app.listen(port, () => console.log(`API on http://localhost:${port}`))