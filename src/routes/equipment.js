const router = require('express').Router()
const { PrismaClient } = require('@prisma/client')
const { auth } = require('../middleware/auth')
const { z } = require('zod')
const prisma = new PrismaClient()

// 목록 조회 (공개)
router.get('/', async (_, res) => {
  const list = await prisma.equipment.findMany({ orderBy: { id: 'desc' } })
  res.json(list)
})

// 생성/수정/삭제는 관리자만
const eqSchema = z.object({ name: z.string().min(1), location: z.string().optional() })
router.post('/', auth('ADMIN'), async (req, res) => {
  const parse = eqSchema.safeParse(req.body)
  if (!parse.success) return res.status(400).json({ error: '입력 형식 오류' })
  const created = await prisma.equipment.create({ data: parse.data })
  res.status(201).json(created)
})

router.put('/:id', auth('ADMIN'), async (req, res) => {
  const id = Number(req.params.id)
  const parse = eqSchema.partial().safeParse(req.body)
  if (!parse.success) return res.status(400).json({ error: '입력 형식 오류' })
  const updated = await prisma.equipment.update({ where: { id }, data: parse.data })
  res.json(updated)
})

router.delete('/:id', auth('ADMIN'), async (req, res) => {
  const id = Number(req.params.id)
  await prisma.equipment.delete({ where: { id } })
  res.status(204).end()
})

module.exports = router
