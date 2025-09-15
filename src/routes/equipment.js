const router = require('express').Router()
const { PrismaClient } = require('@prisma/client')
const { auth } = require('../middleware/auth')
const { z } = require('zod')
const jwt = require('jsonwebtoken')
const prisma = new PrismaClient()

// 목록 조회 (공개) - 카테고리 필터링 지원
router.get('/', async (req, res) => {
  try {
    const { category, search } = req.query
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    let userId = null

    // 토큰이 있으면 사용자 ID 추출 (선택적)
    if (token) {
      try {
        const payload = jwt.verify(token, process.env.JWT_SECRET)
        userId = payload.id
      } catch (e) {
        // 토큰이 유효하지 않아도 목록 조회는 가능
      }
    }

    // 필터 조건 구성
    const where = {}
    if (category && category !== 'all') {
      where.category = category
    }
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { muscleGroup: { contains: search, mode: 'insensitive' } }
      ]
    }

    const list = await prisma.equipment.findMany({ 
      where,
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: { reservations: true }
        },
        // 사용자가 로그인했으면 즐겨찾기 정보 포함
        favorites: userId ? {
          where: { userId },
          select: { id: true }
        } : false
      }
    })

    // 응답 데이터 가공
    const response = list.map(equipment => ({
      id: equipment.id,
      name: equipment.name,
      imageUrl: equipment.imageUrl,
      category: equipment.category,
      muscleGroup: equipment.muscleGroup,
      createdAt: equipment.createdAt,
      reservationCount: equipment._count.reservations,
      isFavorite: userId ? equipment.favorites.length > 0 : false
    }))

    res.json(response)
  } catch (error) {
    console.error('기구 목록 조회 오류:', error)
    res.status(500).json({ error: '기구 목록을 불러올 수 없습니다' })
  }
})

// 카테고리 목록 조회
router.get('/categories', async (req, res) => {
  try {
    const categories = await prisma.equipment.groupBy({
      by: ['category'],
      _count: {
        category: true
      },
      orderBy: {
        category: 'asc'
      }
    })

    res.json(categories.map(cat => ({
      name: cat.category,
      count: cat._count.category
    })))
  } catch (error) {
    console.error('카테고리 조회 오류:', error)
    res.status(500).json({ error: '카테고리를 불러올 수 없습니다' })
  }
})

// 특정 기구 상세 조회
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id)
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    let userId = null

    // 토큰이 있으면 사용자 ID 추출 (선택적)
    if (token) {
      try {
        const payload = jwt.verify(token, process.env.JWT_SECRET)
        userId = payload.id
      } catch (e) {
        // 토큰이 유효하지 않아도 상세 조회는 가능
      }
    }

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
        },
        favorites: userId ? {
          where: { userId },
          select: { id: true }
        } : false,
        _count: {
          select: { favorites: true }
        }
      }
    })
    
    if (!equipment) {
      return res.status(404).json({ error: '기구를 찾을 수 없습니다' })
    }

    // 응답 데이터 가공
    const response = {
      id: equipment.id,
      name: equipment.name,
      imageUrl: equipment.imageUrl,
      category: equipment.category,
      muscleGroup: equipment.muscleGroup,
      createdAt: equipment.createdAt,
      reservations: equipment.reservations,
      isFavorite: userId ? equipment.favorites.length > 0 : false,
      favoriteCount: equipment._count.favorites
    }
    
    res.json(response)
  } catch (error) {
    console.error('기구 상세 조회 오류:', error)
    res.status(500).json({ error: '기구 정보를 불러올 수 없습니다' })
  }
})

module.exports = router