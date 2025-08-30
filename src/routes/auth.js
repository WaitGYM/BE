const router = require('express').Router()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const { z } = require('zod')

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1)
})
router.post('/register', async (req, res) => {
  const parse = registerSchema.safeParse(req.body)
  if (!parse.success) return res.status(400).json({ error: '입력 형식 오류' })

  const { email, password, name } = parse.data
  const exists = await prisma.user.findUnique({ where: { email } })
  if (exists) return res.status(409).json({ error: '이미 존재하는 이메일' })

  const hash = await bcrypt.hash(password, 10)
  const user = await prisma.user.create({ data: { email, password: hash, name } })
  res.status(201).json({ id: user.id, email: user.email, name: user.name })
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
})
router.post('/login', async (req, res) => {
  const parse = loginSchema.safeParse(req.body)
  if (!parse.success) return res.status(400).json({ error: '입력 형식 오류' })

  const { email, password } = parse.data
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) return res.status(401).json({ error: '이메일/비번 확인' })

  const ok = await bcrypt.compare(password, user.password)
  if (!ok) return res.status(401).json({ error: '이메일/비번 확인' })

  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' })
  res.json({ token })
})

module.exports = router
