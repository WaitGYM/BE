require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { PrismaClient } = require('@prisma/client')

const authRoutes = require('./routes/auth')
const equipmentRoutes = require('./routes/equipment')
const reservationRoutes = require('./routes/reservations')

const app = express()
const prisma = new PrismaClient()

app.use(cors({ origin: true, credentials: true }))
app.use(express.json())

app.get('/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }))

app.use('/api/auth', authRoutes)
app.use('/api/equipment', equipmentRoutes)
app.use('/api/reservations', reservationRoutes)

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
