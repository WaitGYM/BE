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

// CORS: 프론트 도메인 정확히 지정 + 자격증명 허용
app.use(cors({
  origin: [
    'https://waitgym.life', 
    'https://www.waitgym.life', 
    'https://waitgym-fe-web-two.vercel.app',
    // 개발 환경을 위해 localhost도 포함 (필요시)
    ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000'] : [])
  ],
  credentials: true
}))

app.use(express.json())

// 세션 설정 - HTTPS 환경에 맞게 수정
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', // 다른 도메인과 통신이면 필수
    secure: process.env.NODE_ENV === 'production', // HTTPS 전용 (프로덕션에서만)
    maxAge: 24 * 60 * 60 * 1000 // 24시간
  }
}))

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