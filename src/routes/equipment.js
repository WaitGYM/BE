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

// 기구 검색 (상태 정보 포함)
router.get('/search', async (req, res) => {
  try {
    const { q, category, available_only } = req.query
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    let userId = null

    // 토큰이 있으면 사용자 ID 추출 (선택적)
    if (token) {
      try {
        const payload = jwt.verify(token, process.env.JWT_SECRET)
        userId = payload.id
      } catch (e) {
        // 토큰이 유효하지 않아도 검색은 가능
      }
    }

    // 검색 조건 구성
    const where = {}
    
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { category: { contains: q, mode: 'insensitive' } },
        { muscleGroup: { contains: q, mode: 'insensitive' } }
      ]
    }
    
    if (category && category !== 'all') {
      where.category = category
    }

    let equipmentList = await prisma.equipment.findMany({
      where,
      orderBy: { name: 'asc' },
      include: {
        favorites: userId ? {
          where: { userId },
          select: { id: true }
        } : false
      }
    })

    // 현재 사용 상태 조회
    const equipmentIds = equipmentList.map(eq => eq.id)
    const currentUsages = await prisma.equipmentUsage.findMany({
      where: {
        equipmentId: { in: equipmentIds },
        status: 'IN_USE'
      },
      include: {
        user: { select: { name: true } }
      }
    })

    // 대기열 정보 조회
    const waitingQueues = await prisma.waitingQueue.findMany({
      where: {
        equipmentId: { in: equipmentIds },
        status: { in: ['WAITING', 'NOTIFIED'] }
      }
    })

    // 내 대기 정보 (로그인한 경우)
    let myQueues = []
    if (userId) {
      myQueues = await prisma.waitingQueue.findMany({
        where: {
          userId,
          equipmentId: { in: equipmentIds },
          status: { in: ['WAITING', 'NOTIFIED'] }
        }
      })
    }

    // 내가 현재 사용 중인 기구
    let myCurrentUsage = null
    if (userId) {
      myCurrentUsage = await prisma.equipmentUsage.findFirst({
        where: { userId, status: 'IN_USE' }
      })
    }

    // 응답 데이터 구성
    let response = equipmentList.map(equipment => {
      const currentUsage = currentUsages.find(u => u.equipmentId === equipment.id)
      const queueCount = waitingQueues.filter(q => q.equipmentId === equipment.id).length
      const myQueue = myQueues.find(q => q.equipmentId === equipment.id)
      
      const isAvailable = !currentUsage
      const canStart = isAvailable && !myQueue && (!myCurrentUsage || myCurrentUsage.equipmentId === equipment.id)
      const canQueue = !isAvailable && !myQueue && (!myCurrentUsage || myCurrentUsage.equipmentId === equipment.id)

      return {
        id: equipment.id,
        name: equipment.name,
        imageUrl: equipment.imageUrl,
        category: equipment.category,
        muscleGroup: equipment.muscleGroup,
        createdAt: equipment.createdAt,
        isFavorite: userId ? equipment.favorites.length > 0 : false,
        // 상태 정보
        status: {
          isAvailable,
          currentUser: currentUsage ? currentUsage.user.name : null,
          currentUserStartedAt: currentUsage ? currentUsage.startedAt : null,
          waitingCount: queueCount,
          myQueuePosition: myQueue ? myQueue.queuePosition : null,
          myQueueStatus: myQueue ? myQueue.status : null,
          canStart: userId ? canStart : false,
          canQueue: userId ? canQueue : false
        }
      }
    })

    // 사용 가능한 기구만 필터링 (요청 시)
    if (available_only === 'true') {
      response = response.filter(eq => eq.status.isAvailable)
    }

    res.json(response)
  } catch (error) {
    console.error('기구 검색 오류:', error)
    res.status(500).json({ error: '기구 검색에 실패했습니다' })
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

// 기구별 빠른 액션 API (검색에서 바로 시작/대기)
router.post('/:id/quick-start', auth(), async (req, res) => {
  try {
    const equipmentId = parseInt(req.params.id)
    const { totalSets = 3, restMinutes = 3 } = req.body

    // 기구 존재 확인
    const equipment = await prisma.equipment.findUnique({
      where: { id: equipmentId }
    })
    
    if (!equipment) {
      return res.status(404).json({ error: '기구를 찾을 수 없습니다' })
    }

    // 현재 사용 중인지 확인
    const currentUsage = await prisma.equipmentUsage.findFirst({
      where: { equipmentId, status: 'IN_USE' },
      include: { user: { select: { name: true } } }
    })

    if (currentUsage) {
      return res.status(409).json({ 
        error: '기구가 사용 중입니다',
        currentUser: currentUsage.user.name,
        startedAt: currentUsage.startedAt,
        message: '대기열에 등록하거나 나중에 다시 시도해주세요'
      })
    }

    // 내가 이미 다른 기구 사용 중인지 확인
    const myUsage = await prisma.equipmentUsage.findFirst({
      where: { userId: req.user.id, status: 'IN_USE' },
      include: { equipment: { select: { name: true } } }
    })

    if (myUsage) {
      return res.status(409).json({ 
        error: '이미 다른 기구를 사용 중입니다',
        currentEquipment: myUsage.equipment.name,
        equipmentId: myUsage.equipmentId
      })
    }

    // 대기열 확인 (내가 첫 번째가 아니면 시작 불가)
    const firstInQueue = await prisma.waitingQueue.findFirst({
      where: { equipmentId, status: { in: ['WAITING', 'NOTIFIED'] } },
      orderBy: { queuePosition: 'asc' }
    })

    if (firstInQueue && firstInQueue.userId !== req.user.id) {
      return res.status(403).json({ 
        error: '대기 순서가 아닙니다',
        message: '먼저 대기열에 등록해주세요'
      })
    }

    // 기구 사용 시작
    const usage = await prisma.$transaction(async (tx) => {
      const newUsage = await tx.equipmentUsage.create({
        data: {
          equipmentId,
          userId: req.user.id,
          totalSets,
          restMinutes,
          status: 'IN_USE',
          setStatus: 'EXERCISING',
          currentSet: 1,
          currentSetStartedAt: new Date(),
          estimatedEndAt: new Date(Date.now() + ((totalSets * 5) + ((totalSets - 1) * restMinutes)) * 60 * 1000)
        }
      })

      // 내가 대기열에 있었다면 완료 처리
      if (firstInQueue && firstInQueue.userId === req.user.id) {
        await tx.waitingQueue.update({
          where: { id: firstInQueue.id },
          data: { status: 'COMPLETED' }
        })
      }

      return newUsage
    })

    res.json({
      message: `${equipment.name} 사용을 시작했습니다`,
      equipmentName: equipment.name,
      totalSets,
      restMinutes,
      usageId: usage.id
    })
  } catch (error) {
    console.error('빠른 시작 오류:', error)
    res.status(500).json({ error: '기구 사용 시작에 실패했습니다' })
  }
})

// 기구별 빠른 대기 등록
router.post('/:id/quick-queue', auth(), async (req, res) => {
  try {
    const equipmentId = parseInt(req.params.id)

    // 기구 존재 확인
    const equipment = await prisma.equipment.findUnique({
      where: { id: equipmentId }
    })
    
    if (!equipment) {
      return res.status(404).json({ error: '기구를 찾을 수 없습니다' })
    }

    // 이미 대기 중인지 확인
    const existingQueue = await prisma.waitingQueue.findFirst({
      where: { 
        equipmentId, 
        userId: req.user.id, 
        status: { in: ['WAITING', 'NOTIFIED'] } 
      }
    })

    if (existingQueue) {
      return res.status(409).json({ 
        error: '이미 대기열에 등록되어 있습니다',
        queuePosition: existingQueue.queuePosition,
        status: existingQueue.status
      })
    }

    // 내가 다른 기구 사용 중인지 확인
    const myUsage = await prisma.equipmentUsage.findFirst({
      where: { userId: req.user.id, status: 'IN_USE' },
      include: { equipment: { select: { name: true } } }
    })

    if (myUsage) {
      return res.status(409).json({ 
        error: '이미 다른 기구를 사용 중입니다',
        currentEquipment: myUsage.equipment.name
      })
    }

    // 대기열 길이 확인
    const queueLength = await prisma.waitingQueue.count({
      where: { equipmentId, status: { in: ['WAITING', 'NOTIFIED'] } }
    })

    // 대기열에 추가
    const queue = await prisma.waitingQueue.create({
      data: {
        equipmentId,
        userId: req.user.id,
        queuePosition: queueLength + 1,
        status: 'WAITING'
      }
    })

    res.json({
      message: `${equipment.name} 대기열에 등록되었습니다`,
      equipmentName: equipment.name,
      queuePosition: queue.queuePosition,
      queueId: queue.id,
      estimatedWaitMinutes: Math.max(5, queueLength * 15) // 간단한 예상 대기시간
    })
  } catch (error) {
    console.error('빠른 대기 등록 오류:', error)
    res.status(500).json({ error: '대기열 등록에 실패했습니다' })
  }
})

module.exports = router