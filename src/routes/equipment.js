const router = require('express').Router()
const { PrismaClient } = require('@prisma/client')
const { auth } = require('../middleware/auth')
const { z } = require('zod')
const jwt = require('jsonwebtoken')
const prisma = new PrismaClient()

// 🔥 실시간 상태 조회 헬퍼 함수
async function getEquipmentStatusInfo(equipmentIds, userId = null) {
  // 현재 사용 중인 기구들
  const currentUsages = await prisma.equipmentUsage.findMany({
    where: {
      equipmentId: { in: equipmentIds },
      status: 'IN_USE'
    },
    include: {
      user: { select: { name: true } }
    }
  })

  // 대기열 정보
  const waitingQueues = await prisma.waitingQueue.findMany({
    where: {
      equipmentId: { in: equipmentIds },
      status: { in: ['WAITING', 'NOTIFIED'] }
    },
    orderBy: { queuePosition: 'asc' }
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
// 🆕 오늘 내가 완료한 기구들 추가
  let myCompletedToday = new Map()
  if (userId) {
    const today = new Date()
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    
    const completedUsages = await prisma.equipmentUsage.findMany({
      where: {
        userId,
        equipmentId: { in: equipmentIds },
        status: 'COMPLETED',
        endedAt: { gte: startOfDay }
      },
      orderBy: { endedAt: 'desc' }
    })
    
    completedUsages.forEach(usage => {
      if (!myCompletedToday.has(usage.equipmentId)) {
        const durationMin = usage.startedAt && usage.endedAt
          ? Math.round((new Date(usage.endedAt) - new Date(usage.startedAt)) / 60000)
          : null
        myCompletedToday.set(usage.equipmentId, {
          status: usage.status,
          lastCompletedAt: usage.endedAt,
          totalSets: usage.totalSets,   // ✅ currentSet → totalSets
          setStatus: usage.setStatus,
          duration: Math.round((new Date(usage.endedAt) - new Date(usage.startedAt)) / 60000)
        })
      }
    })
  }
  
  // 기구별 상태 정보 매핑
  const statusMap = new Map()
  
  equipmentIds.forEach(equipmentId => {
    const currentUsage = currentUsages.find(u => u.equipmentId === equipmentId)
    const queueCount = waitingQueues.filter(q => q.equipmentId === equipmentId).length
    const myQueue = myQueues.find(q => q.equipmentId === equipmentId)
    
    const isAvailable = !currentUsage
    const canStart = isAvailable && !myQueue && (!myCurrentUsage || myCurrentUsage.equipmentId === equipmentId)
    const canQueue = !isAvailable && !myQueue && (!myCurrentUsage || myCurrentUsage.equipmentId === equipmentId)

    // ✅ 오늘 내가 완료한 기록(있으면) 꺼내기
    const myCompleted = userId ? (myCompletedToday.get(equipmentId) || null) : null

    statusMap.set(equipmentId, {
      isAvailable,
      currentUser: currentUsage ? currentUsage.user.name : null,
      currentUserStartedAt: currentUsage ? currentUsage.startedAt : null,
      currentUsageInfo: currentUsage ? {
        totalSets: currentUsage.totalSets,
        currentSet: currentUsage.currentSet,
        setStatus: currentUsage.setStatus,
        restSeconds: currentUsage.restSeconds,
        progress: (currentUsage.totalSets > 0)
        ? Math.round((currentUsage.currentSet / currentUsage.totalSets) * 100)
        : 0,

        estimatedEndAt: currentUsage.estimatedEndAt
      } : null,
      waitingCount: queueCount,
      myQueuePosition: myQueue ? myQueue.queuePosition : null,
      myQueueStatus: myQueue ? myQueue.status : null,
      canStart: userId ? canStart : false,
      canQueue: userId ? canQueue : false,

      // 🆕 완료 표시 정보 추가
      // ✅ 완료 정보(미정의/오타 방지)
      completedToday: !!myCompleted,
      lastCompletedAt: myCompleted?.lastCompletedAt ?? null,
      lastCompletedSets: myCompleted?.totalSets ?? null,
      lastCompletedDuration: myCompleted?.duration ?? null,
      wasFullyCompleted: myCompleted?.status === 'COMPLETED'


    })
  })

  return statusMap
}

// 🔥 목록 조회 (실시간 상태 포함)
router.get('/', async (req, res) => {
  try {
    const { category, search, include_status = 'true' } = req.query
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
        { muscleGroup: { contains: search, mode: 'insensitive' } }
      ]
    }

    const list = await prisma.equipment.findMany({ 
      where,
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: { 
            waitingQueues: true
           }
        },
        // 사용자가 로그인했으면 즐겨찾기 정보 포함
        favorites: userId ? {
          where: { userId },
          select: { id: true }
        } : false
      }
    })

    // 🔥 실시간 상태 정보 조회
    let statusMap = new Map()
    if (include_status === 'true') {
      const equipmentIds = list.map(eq => eq.id)
      statusMap = await getEquipmentStatusInfo(equipmentIds, userId)
    }

    // 응답 데이터 가공
    const response = list.map(equipment => {
      const baseInfo = {
        id: equipment.id,
        name: equipment.name,
        imageUrl: equipment.imageUrl,
        category: equipment.category,
        muscleGroup: equipment.muscleGroup,
        createdAt: equipment.createdAt,
        isFavorite: userId ? equipment.favorites.length > 0 : false
      }

      // 🔥 실시간 상태 정보 추가
      if (include_status === 'true') {
        baseInfo.status = statusMap.get(equipment.id) || {
          isAvailable: true,
          currentUser: null,
          currentUserStartedAt: null,
          currentUsageInfo: null,
          waitingCount: 0,
          myQueuePosition: null,
          myQueueStatus: null,
          canStart: false,
          canQueue: false,

          // 완료 기본값
          completedToday: false,
          lastCompletedAt: null,
          lastCompletedSets: null,
          lastCompletedDuration: null,
          wasFullyCompleted: false
        }
      }

      return baseInfo
    })

    res.json(response)
  } catch (error) {
    console.error('기구 목록 조회 오류:', error)
    res.status(500).json({ error: '기구 목록을 불러올 수 없습니다' })
  }
})

// 🔥 기구 검색 (기존 코드 간소화)
router.get('/search', async (req, res) => {
  try {
    const { q, category, available_only } = req.query
    
    // 기본 목록 조회와 동일한 로직 사용
    const queryParams = new URLSearchParams({
      ...(q && { search: q }),
      ...(category && { category }),
      include_status: 'true'
    })
    
    // 내부적으로 기본 목록 조회 재사용
    req.query = { 
      search: q, 
      category, 
      include_status: 'true' 
    }
    
    // 기본 목록 조회 로직 재사용
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    let userId = null

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

    // 실시간 상태 정보 조회
    const equipmentIds = equipmentList.map(eq => eq.id)
    const statusMap = await getEquipmentStatusInfo(equipmentIds, userId)

    // 응답 데이터 구성
    let response = equipmentList.map(equipment => ({
      id: equipment.id,
      name: equipment.name,
      imageUrl: equipment.imageUrl,
      category: equipment.category,
      muscleGroup: equipment.muscleGroup,
      createdAt: equipment.createdAt,
      isFavorite: userId ? equipment.favorites.length > 0 : false,
      status: statusMap.get(equipment.id)
    }))

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

// 🔥 실시간 상태만 조회하는 경량 API 추가
router.get('/status', async (req, res) => {
  try {
    const { equipmentIds } = req.query // 쉼표로 구분된 ID 목록
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    let userId = null

    if (token) {
      try {
        const payload = jwt.verify(token, process.env.JWT_SECRET)
        userId = payload.id
      } catch (e) {
        // 토큰이 유효하지 않아도 상태 조회는 가능
      }
    }

    if (!equipmentIds) {
      return res.status(400).json({ error: 'equipmentIds 파라미터가 필요합니다' })
    }

    const ids = equipmentIds.split(',').map(id => parseInt(id)).filter(id => !isNaN(id))
    if (ids.length === 0) {
      return res.status(400).json({ error: '유효한 equipmentIds가 필요합니다' })
    }

    const statusMap = await getEquipmentStatusInfo(ids, userId)
    
    // Map을 Object로 변환
    const statusObject = {}
    statusMap.forEach((status, equipmentId) => {
      statusObject[equipmentId] = status
    })

    res.json(statusObject)
  } catch (error) {
    console.error('기구 상태 조회 오류:', error)
    res.status(500).json({ error: '기구 상태를 불러올 수 없습니다' })
  }
})

/* ===========================
 * 🆕 내가 완료한 운동/통계 API 추가
 * =========================== */

// 🔥 내가 사용한 기구 목록 (운동 완료 표시용)
router.get('/my-completed', auth(), async (req, res) => {
  try {
    const { date, limit = 20 } = req.query
    
    let where = {
      userId: req.user.id,
      status: 'COMPLETED'
    }
    
    // 특정 날짜 필터링
    if (date) {
      const targetDate = new Date(date)
      const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate())
      const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1)
      
      where.endedAt = {
        gte: startOfDay,
        lte: endOfDay
      }
    }

    const completedUsages = await prisma.equipmentUsage.findMany({
      where,
      include: {
        equipment: {
          select: {
            id: true,
            name: true,
            category: true,
            muscleGroup: true,
            imageUrl: true
          }
        }
      },
      orderBy: { endedAt: 'desc' },
      take: parseInt(limit)
    })

    const response = completedUsages.map(usage => ({
      id: usage.id,
      equipmentId: usage.equipmentId,
      equipment: usage.equipment,
      startedAt: usage.startedAt,
      endedAt: usage.endedAt,
      totalSets: usage.totalSets,
      completedSets: usage.currentSet,
      restMinutes: typeof usage.restSeconds === 'number' ? Math.floor(usage.restSeconds / 60) : null,
      setStatus: usage.setStatus,
      duration: (usage.startedAt && usage.endedAt)
        ? Math.round((new Date(usage.endedAt) - new Date(usage.startedAt)) / 60000)
        : null, // 분 단위
      isFullyCompleted: usage.setStatus === 'COMPLETED', // 모든 세트 완료 여부
      wasInterrupted: ['STOPPED', 'FORCE_COMPLETED'].includes(usage.setStatus) // 중단된 운동
    }))

    res.json(response)
  } catch (error) {
    console.error('완료된 운동 조회 오류:', error)
    res.status(500).json({ error: '완료된 운동 목록을 불러올 수 없습니다' })
  }
})

// 🔥 운동 통계 API
router.get('/my-stats', auth(), async (req, res) => {
  try {
    const { period = 'week' } = req.query // today, week, month, year
    
    let startDate
    const now = new Date()
    
    switch (period) {
      case 'today':
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        break
      case 'week':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        break
      case 'month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1)
        break
      case 'year':
        startDate = new Date(now.getFullYear(), 0, 1)
        break
      default:
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    }

    const stats = await prisma.equipmentUsage.findMany({
      where: {
        userId: req.user.id,
        status: 'COMPLETED',
        endedAt: { gte: startDate }
      },
      include: {
        equipment: {
          select: { id: true, name: true, category: true }
        }
      },
      orderBy: { endedAt: 'asc' }
    })

    // 기구별 사용 횟수/세트/시간
    const equipmentStats = stats.reduce((acc, usage) => {
      const key = usage.equipmentId
      if (!acc[key]) {
        acc[key] = {
          equipment: usage.equipment,
          count: 0,
          totalSets: 0,
          totalMinutes: 0,
          lastUsed: null
        }
      }
      acc[key].count++
      acc[key].totalSets += (usage.currentSet || 0)
      if (usage.startedAt && usage.endedAt) {
        acc[key].totalMinutes += Math.round((new Date(usage.endedAt) - new Date(usage.startedAt)) / 60000)
        acc[key].lastUsed = !acc[key].lastUsed || usage.endedAt > acc[key].lastUsed ? usage.endedAt : acc[key].lastUsed
      }
      return acc
    }, {})

    // 카테고리별 통계
    const categoryStatsMap = stats.reduce((acc, usage) => {
      const category = usage.equipment?.category || '기타'
      if (!acc[category]) {
        acc[category] = { count: 0, totalSets: 0 }
      }
      acc[category].count++
      acc[category].totalSets += (usage.currentSet || 0)
      return acc
    }, {})

    const totalSets = stats.reduce((sum, u) => sum + (u.currentSet || 0), 0)
    const totalMinutes = stats.reduce((sum, u) => {
      if (u.startedAt && u.endedAt) {
        return sum + Math.round((new Date(u.endedAt) - new Date(u.startedAt)) / 60000)
      }
      return sum
    }, 0)

    res.json({
      period,
      totalWorkouts: stats.length,
      totalSets,
      totalMinutes,
      averageSetsPerWorkout: stats.length ? Math.round(totalSets / stats.length) : 0,
      equipmentStats: Object.values(equipmentStats).sort((a, b) => b.count - a.count),
      categoryStats: Object.entries(categoryStatsMap).map(([category, data]) => ({
        category,
        ...data
      })).sort((a, b) => b.count - a.count),
      recentWorkouts: stats.slice(-5).reverse()
    })
  } catch (error) {
    console.error('운동 통계 조회 오류:', error)
    res.status(500).json({ error: '운동 통계를 불러올 수 없습니다' })
  }
})

// 특정 기구 상세 조회 (실시간 상태 포함)
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

    // 🔥 실시간 상태 정보 추가
    const statusMap = await getEquipmentStatusInfo([id], userId)
    const status = statusMap.get(id)

    // 응답 데이터 가공
    const response = {
      id: equipment.id,
      name: equipment.name,
      imageUrl: equipment.imageUrl,
      category: equipment.category,
      muscleGroup: equipment.muscleGroup,
      createdAt: equipment.createdAt,
      isFavorite: userId ? equipment.favorites.length > 0 : false,
      favoriteCount: equipment._count.favorites,
      status: status // 🔥 실시간 상태 정보 포함
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
    const { totalSets = 3, restSeconds = 180 } = req.body

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
          restSeconds,
          status: 'IN_USE',
          setStatus: 'EXERCISING',
          currentSet: 1,
          currentSetStartedAt: new Date(),
          estimatedEndAt: new Date(Date.now() + ((totalSets * 5) + ((totalSets - 1) * (restSeconds / 60))) * 60 * 1000)
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
      restSeconds,
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