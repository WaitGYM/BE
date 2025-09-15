const router = require('express').Router()
const { PrismaClient } = require('@prisma/client')
const { auth } = require('../middleware/auth')
const prisma = new PrismaClient()

// 내 즐겨찾기 목록 조회
router.get('/', auth(), async (req, res) => {
  try {
    const favorites = await prisma.favorite.findMany({
      where: { userId: req.user.id },
      include: {
        equipment: {
          include: {
            _count: {
              select: { reservations: true }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    })
    
    res.json(favorites.map(fav => ({
      id: fav.id,
      createdAt: fav.createdAt,
      equipment: {
        id: fav.equipment.id,
        name: fav.equipment.name,
        imageUrl: fav.equipment.imageUrl,
        category: fav.equipment.category,
        muscleGroup: fav.equipment.muscleGroup,
        reservationCount: fav.equipment._count.reservations,
        isFavorite: true
      }
    })))
  } catch (error) {
    console.error('즐겨찾기 조회 오류:', error)
    res.status(500).json({ error: '즐겨찾기를 불러올 수 없습니다' })
  }
})

// 즐겨찾기 추가
router.post('/', auth(), async (req, res) => {
  try {
    const { equipmentId } = req.body
    
    if (!equipmentId || typeof equipmentId !== 'number') {
      return res.status(400).json({ error: 'equipmentId가 필요합니다' })
    }

    // 기구 존재 확인
    const equipment = await prisma.equipment.findUnique({
      where: { id: equipmentId }
    })
    
    if (!equipment) {
      return res.status(404).json({ error: '기구를 찾을 수 없습니다' })
    }

    // 이미 즐겨찾기에 있는지 확인
    const existing = await prisma.favorite.findUnique({
      where: {
        userId_equipmentId: {
          userId: req.user.id,
          equipmentId: equipmentId
        }
      }
    })

    if (existing) {
      return res.status(409).json({ error: '이미 즐겨찾기에 추가된 기구입니다' })
    }

    const favorite = await prisma.favorite.create({
      data: {
        userId: req.user.id,
        equipmentId: equipmentId
      },
      include: {
        equipment: true
      }
    })

    res.status(201).json({
      id: favorite.id,
      createdAt: favorite.createdAt,
      equipment: {
        ...favorite.equipment,
        isFavorite: true
      }
    })
  } catch (error) {
    console.error('즐겨찾기 추가 오류:', error)
    res.status(500).json({ error: '즐겨찾기 추가에 실패했습니다' })
  }
})

// 즐겨찾기 제거
router.delete('/equipment/:equipmentId', auth(), async (req, res) => {
  try {
    const equipmentId = Number(req.params.equipmentId)
    
    if (!equipmentId) {
      return res.status(400).json({ error: '유효하지 않은 기구 ID입니다' })
    }

    const deleted = await prisma.favorite.deleteMany({
      where: {
        userId: req.user.id,
        equipmentId: equipmentId
      }
    })

    if (deleted.count === 0) {
      return res.status(404).json({ error: '즐겨찾기에서 찾을 수 없습니다' })
    }

    res.status(204).end()
  } catch (error) {
    console.error('즐겨찾기 제거 오류:', error)
    res.status(500).json({ error: '즐겨찾기 제거에 실패했습니다' })
  }
})

// 특정 기구가 즐겨찾기인지 확인
router.get('/check/:equipmentId', auth(), async (req, res) => {
  try {
    const equipmentId = Number(req.params.equipmentId)
    
    const favorite = await prisma.favorite.findUnique({
      where: {
        userId_equipmentId: {
          userId: req.user.id,
          equipmentId: equipmentId
        }
      }
    })

    res.json({ isFavorite: !!favorite })
  } catch (error) {
    console.error('즐겨찾기 확인 오류:', error)
    res.status(500).json({ error: '즐겨찾기 상태를 확인할 수 없습니다' })
  }
})

module.exports = router