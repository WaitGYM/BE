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