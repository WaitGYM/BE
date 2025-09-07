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

// 기존 equipment.js 파일의 맨 아래, module.exports = router 바로 위에 추가하세요

// 장비 상세 정보 (예약 현황 포함)
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id)
    
    const equipment = await prisma.equipment.findUnique({
      where: { id },
      include: {
        _count: {
          select: { reservations: true }
        }
      }
    })
    
    if (!equipment) {
      return res.status(404).json({ error: '장비를 찾을 수 없습니다' })
    }
    
    // 오늘 예약 현황
    const today = new Date()
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    const endOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
    
    const todayReservations = await prisma.reservation.findMany({
      where: {
        equipmentId: id,
        startAt: {
          gte: startOfToday,
          lt: endOfToday
        }
      },
      orderBy: { startAt: 'asc' },
      select: {
        id: true,
        startAt: true,
        endAt: true,
        status: true
      }
    })
    
    res.json({
      ...equipment,
      todayReservations
    })
  } catch (error) {
    console.error('Equipment detail error:', error)
    res.status(500).json({ error: '장비 정보 조회 실패' })
  }
})

// 인기 장비 순위
router.get('/popular/ranking', async (req, res) => {
  try {
    const days = Number(req.query.days) || 30 // 기본 30일
    const pastDate = new Date()
    pastDate.setDate(pastDate.getDate() - days)
    
    const popularEquipment = await prisma.reservation.groupBy({
      by: ['equipmentId'],
      where: {
        startAt: {
          gte: pastDate
        }
      },
      _count: {
        equipmentId: true
      },
      orderBy: {
        _count: {
          equipmentId: 'desc'
        }
      }
    })
    
    // 장비 상세 정보 가져오기
    const equipmentIds = popularEquipment.map(item => item.equipmentId)
    const equipmentDetails = await prisma.equipment.findMany({
      where: {
        id: { in: equipmentIds }
      }
    })
    
    const ranking = popularEquipment.map((item, index) => {
      const equipment = equipmentDetails.find(eq => eq.id === item.equipmentId)
      return {
        rank: index + 1,
        id: item.equipmentId,
        name: equipment?.name || 'Unknown',
        location: equipment?.location,
        reservationCount: item._count.equipmentId
      }
    })
    
    res.json({
      period: `최근 ${days}일`,
      ranking
    })
  } catch (error) {
    console.error('Popular equipment error:', error)
    res.status(500).json({ error: '인기 장비 조회 실패' })
  }
})

// 장비 검색
router.get('/search/:query', async (req, res) => {
  try {
    const query = req.params.query
    
    const equipment = await prisma.equipment.findMany({
      where: {
        OR: [
          {
            name: {
              contains: query,
              mode: 'insensitive'
            }
          },
          {
            location: {
              contains: query,
              mode: 'insensitive'
            }
          }
        ]
      },
      include: {
        _count: {
          select: { reservations: true }
        }
      },
      orderBy: { name: 'asc' }
    })
    
    res.json({
      query,
      results: equipment,
      count: equipment.length
    })
  } catch (error) {
    console.error('Equipment search error:', error)
    res.status(500).json({ error: '장비 검색 실패' })
  }
})
module.exports = router
