const router = require('express').Router()
const { PrismaClient } = require('@prisma/client')
const { auth } = require('../middleware/auth')
const { z } = require('zod')
const prisma = new PrismaClient()

// 목록 조회 (공개)
router.get('/', async (req, res) => {
  const list = await prisma.equipment.findMany({ 
    orderBy: { name: 'asc' },
    include: {
      _count: {
        select: { reservations: true }
      }
    }
  })
  res.json(list)
})

// 특정 기구 상세 조회
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id)
  const equipment = await prisma.equipment.findUnique({
    where: { id },
    include: {
      reservations: {
        where: {
          startAt: { gte: new Date() }
        },
        orderBy: { startAt: 'asc' },
        take: 10,
        include: {
          user: { select: { name: true } }
        }
      }
    }
  })
  
  if (!equipment) {
    return res.status(404).json({ error: '기구를 찾을 수 없습니다' })
  }
  
  res.json(equipment)
})

module.exports = router