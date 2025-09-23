// src/routes/waiting.js - 실시간 ETA와 WebSocket이 통합된 최종 버전

const router = require('express').Router()
const { PrismaClient } = require('@prisma/client')
const { auth } = require('../middleware/auth')
const { 
  sendNotification, 
  broadcastETAUpdate, 
  broadcastEquipmentStatusChange 
} = require('../websocket')
const { z } = require('zod')

const prisma = new PrismaClient()

// ====== 스팸 방지 시스템 ======
const userUpdateLimiter = new Map()
const RATE_LIMIT = {
  WINDOW_MS: 60 * 1000,
  MAX_REQUESTS: 3,
  COOLDOWN_MS: 10 * 1000
}

function checkRateLimit(userId) {
  const now = Date.now()
  const userLimit = userUpdateLimiter.get(userId)
  
  if (!userLimit) {
    userUpdateLimiter.set(userId, { lastUpdate: now, requestCount: 1 })
    return { allowed: true }
  }
  
  if (now - userLimit.lastUpdate > RATE_LIMIT.WINDOW_MS) {
    userUpdateLimiter.set(userId, { lastUpdate: now, requestCount: 1 })
    return { allowed: true }
  }
  
  if (now - userLimit.lastUpdate < RATE_LIMIT.COOLDOWN_MS) {
    return { 
      allowed: false, 
      remainingMs: RATE_LIMIT.COOLDOWN_MS - (now - userLimit.lastUpdate),
      reason: 'cooldown'
    }
  }
  
  if (userLimit.requestCount >= RATE_LIMIT.MAX_REQUESTS) {
    return { 
      allowed: false, 
      remainingMs: RATE_LIMIT.WINDOW_MS - (now - userLimit.lastUpdate),
      reason: 'rate_limit'
    }
  }
  
  userLimit.requestCount++
  userLimit.lastUpdate = now
  return { allowed: true }
}

// ====== ETA 계산 ======
const AVG_SET_MIN = 3
const SETUP_CLEANUP_MIN = 1

function calculateRealTimeETA(usage) {
  if (!usage || usage.status !== 'IN_USE') return 0
  
  const now = Date.now()
  const setMs = AVG_SET_MIN * 60 * 1000
  const restMs = (usage.restSeconds || 0) * 1000
  const remainingSets = Math.max(0, usage.totalSets - usage.currentSet + 1)
  
  if (usage.setStatus === 'EXERCISING') {
    const currentSetElapsed = usage.currentSetStartedAt ? 
      now - usage.currentSetStartedAt.getTime() : 0
    const currentSetRemaining = Math.max(0, setMs - currentSetElapsed)
    const futureWorkTime = (remainingSets - 1) * setMs
    const futureRestTime = (remainingSets - 1) * restMs
    
    return Math.ceil((currentSetRemaining + futureWorkTime + futureRestTime) / 60000)
  }
  
  if (usage.setStatus === 'RESTING') {
    const restElapsed = usage.restStartedAt ? 
      now - usage.restStartedAt.getTime() : 0
    const restRemaining = Math.max(0, restMs - restElapsed)
    const futureWorkTime = remainingSets * setMs
    const futureRestTime = (remainingSets - 1) * restMs
    
    return Math.ceil((restRemaining + futureWorkTime + futureRestTime) / 60000)
  }
  
  return 0
}

function buildQueueETAs(currentETA, queue) {
  const etas = []
  let accumulator = currentETA + SETUP_CLEANUP_MIN
  
  for (let i = 0; i < queue.length; i++) {
    etas.push(accumulator)
    accumulator += AVG_SET_MIN * 3 + 2 + SETUP_CLEANUP_MIN
  }
  
  return etas
}

// ====== 자동 업데이트 시스템 ======
let autoUpdateIntervals = new Map()

async function startAutoUpdate(equipmentId) {
  if (autoUpdateIntervals.has(equipmentId)) return
  
  const intervalId = setInterval(async () => {
    try {
      const currentUsage = await prisma.equipmentUsage.findFirst({
        where: { equipmentId, status: 'IN_USE' },
        include: { user: { select: { name: true } }, equipment: true }
      })
      
      if (!currentUsage) {
        stopAutoUpdate(equipmentId)
        return
      }
      
      const queue = await prisma.waitingQueue.findMany({
        where: { equipmentId, status: { in: ['WAITING', 'NOTIFIED'] } },
        orderBy: { queuePosition: 'asc' },
        include: { user: { select: { name: true } } }
      })
      
      if (queue.length === 0) {
        stopAutoUpdate(equipmentId)
        return
      }
      
      const currentETA = calculateRealTimeETA(currentUsage)
      const queueETAs = buildQueueETAs(currentETA, queue)
      
      // 🔥 WebSocket으로 실시간 브로드캐스트
      const updateData = {
        equipmentId,
        equipmentName: currentUsage.equipment.name,
        currentUsage: {
          userName: currentUsage.user.name,
          totalSets: currentUsage.totalSets,
          currentSet: currentUsage.currentSet,
          setStatus: currentUsage.setStatus,
          estimatedMinutesLeft: currentETA,
          progress: Math.round((currentUsage.currentSet / currentUsage.totalSets) * 100)
        },
        waitingQueue: queue.map((q, index) => ({
          id: q.id,
          position: q.queuePosition,
          userName: q.user.name,
          estimatedWaitMinutes: queueETAs[index]
        })),
        lastUpdated: new Date(),
        isAutoUpdate: true
      }
      
      // 기구 구독자들에게 브로드캐스트
      broadcastETAUpdate(equipmentId, updateData)
      
      // 개별 사용자에게도 알림
      queue.forEach((q, index) => {
        sendNotification(q.userId, {
          type: 'AUTO_ETA_UPDATE',
          title: 'ETA 자동 업데이트',
          message: `${currentUsage.equipment.name} 예상 대기시간: ${queueETAs[index]}분`,
          equipmentId,
          estimatedWaitMinutes: queueETAs[index],
          queuePosition: q.queuePosition
        })
      })
      
    } catch (error) {
      console.error('자동 ETA 업데이트 오류:', error)
      stopAutoUpdate(equipmentId)
    }
  }, 2 * 60 * 1000) // 2분마다
  
  autoUpdateIntervals.set(equipmentId, intervalId)
  console.log(`자동 ETA 업데이트 시작: 기구 ${equipmentId}`)
}

function stopAutoUpdate(equipmentId) {
  const intervalId = autoUpdateIntervals.get(equipmentId)
  if (intervalId) {
    clearInterval(intervalId)
    autoUpdateIntervals.delete(equipmentId)
    console.log(`자동 ETA 업데이트 중지: 기구 ${equipmentId}`)
  }
}

// ====== API 엔드포인트들 ======

// 🔥 ETA 수동 업데이트 API
router.post('/update-eta/:equipmentId', auth(), async (req, res) => {
  try {
    const equipmentId = parseInt(req.params.equipmentId)
    const userId = req.user.id
    
    // 스팸 방지 체크
    const rateLimitCheck = checkRateLimit(userId)
    if (!rateLimitCheck.allowed) {
      const remainingSec = Math.ceil(rateLimitCheck.remainingMs / 1000)
      return res.status(429).json({ 
        error: rateLimitCheck.reason === 'cooldown' ? '너무 자주 업데이트했습니다' : '업데이트 횟수 초과',
        remainingSeconds: remainingSec,
        message: `${remainingSec}초 후 다시 시도해주세요`
      })
    }
    
    const equipment = await prisma.equipment.findUnique({
      where: { id: equipmentId }
    })
    if (!equipment) {
      return res.status(404).json({ error: '기구를 찾을 수 없습니다' })
    }
    
    const currentUsage = await prisma.equipmentUsage.findFirst({
      where: { equipmentId, status: 'IN_USE' },
      include: { user: { select: { name: true } } }
    })
    
    const queue = await prisma.waitingQueue.findMany({
      where: { equipmentId, status: { in: ['WAITING', 'NOTIFIED'] } },
      orderBy: { queuePosition: 'asc' },
      include: { user: { select: { name: true } } }
    })
    
    const currentETA = currentUsage ? calculateRealTimeETA(currentUsage) : 0
    const queueETAs = buildQueueETAs(currentETA, queue)
    const updateTime = new Date()
    
    // 🔥 실시간 브로드캐스트
    const updateData = {
      equipmentId,
      equipmentName: equipment.name,
      updatedAt: updateTime,
      updatedBy: userId,
      currentUsage: currentUsage ? {
        userName: currentUsage.user.name,
        totalSets: currentUsage.totalSets,
        currentSet: currentUsage.currentSet,
        setStatus: currentUsage.setStatus,
        estimatedMinutesLeft: currentETA,
        progress: Math.round((currentUsage.currentSet / currentUsage.totalSets) * 100)
      } : null,
      waitingQueue: queue.map((q, index) => ({
        id: q.id,
        position: q.queuePosition,
        userName: q.user.name,
        estimatedWaitMinutes: queueETAs[index],
        isYou: q.userId === userId
      })),
      totalWaiting: queue.length,
      isManualUpdate: true
    }
    
    // WebSocket 브로드캐스트
    broadcastETAUpdate(equipmentId, updateData)
    
    // 대기 중인 모든 사용자에게 개별 알림
    queue.forEach((q, index) => {
      sendNotification(q.userId, {
        type: 'ETA_UPDATED',
        title: 'ETA 업데이트',
        message: `${equipment.name} 예상 대기시간: ${queueETAs[index]}분`,
        equipmentId,
        equipmentName: equipment.name,
        estimatedWaitMinutes: queueETAs[index],
        queuePosition: q.queuePosition,
        updatedAt: updateTime,
        updatedBy: q.userId === userId ? '나' : '다른 사용자'
      })
    })
    
    res.json(updateData)
    
  } catch (error) {
    console.error('ETA 업데이트 오류:', error)
    res.status(500).json({ error: 'ETA 업데이트에 실패했습니다' })
  }
})

// 🔥 기구 사용 시작 API (자동 업데이트 포함)
router.post('/start-using/:equipmentId', auth(), async (req, res) => {
  try {
    const equipmentId = parseInt(req.params.equipmentId)
    const { totalSets = 3, restSeconds = 180 } = req.body
    
    const equipment = await prisma.equipment.findUnique({ where: { id: equipmentId } })
    if (!equipment) return res.status(404).json({ error: '기구 없음' })

    const currentUsage = await prisma.equipmentUsage.findFirst({
      where: { equipmentId, status: 'IN_USE' }, include: { user: true }
    })
    if (currentUsage) {
      return res.status(409).json({ 
        error: '이미 사용 중', 
        currentUser: currentUsage.user.name, 
        since: currentUsage.startedAt 
      })
    }

    const myUsage = await prisma.equipmentUsage.findFirst({
      where: { userId: req.user.id, status: 'IN_USE' }, 
      include: { equipment: true }
    })
    if (myUsage) {
      return res.status(409).json({ 
        error: '다른 기구 사용 중', 
        currentEquipment: myUsage.equipment.name, 
        equipmentId: myUsage.equipmentId 
      })
    }

    const firstInQueue = await prisma.waitingQueue.findFirst({
      where: { equipmentId, status: { in: ['WAITING', 'NOTIFIED'] } }, 
      orderBy: { queuePosition: 'asc' }
    })
    
    if (firstInQueue && firstInQueue.userId !== req.user.id) {
      return res.status(403).json({ 
        error: '대기 순서가 아님', 
        firstPosition: firstInQueue.queuePosition 
      })
    }

    const usage = await prisma.$transaction(async (tx) => {
      const u = await tx.equipmentUsage.create({
        data: {
          equipmentId,
          userId: req.user.id,
          totalSets,
          currentSet: 1,
          restSeconds,
          status: 'IN_USE',
          setStatus: 'EXERCISING',
          currentSetStartedAt: new Date(),
          estimatedEndAt: new Date(Date.now() + ((totalSets * 5 * 60) + ((totalSets - 1) * restSeconds)) * 1000),
        },
        include: { equipment: true, user: { select: { name: true } } }
      })
      
      if (firstInQueue && firstInQueue.userId === req.user.id) {
        await tx.waitingQueue.update({ 
          where: { id: firstInQueue.id }, 
          data: { status: 'COMPLETED' } 
        })
      }
      
      return u
    })

    // 🔥 상태 변경 브로드캐스트
    broadcastEquipmentStatusChange(equipmentId, {
      type: 'usage_started',
      equipmentName: equipment.name,
      userName: usage.user.name,
      totalSets: usage.totalSets,
      startedAt: usage.startedAt
    })

    // 🔥 자동 ETA 업데이트 시작
    startAutoUpdate(equipmentId)

    res.status(201).json({
      id: usage.id,
      equipmentId: usage.equipmentId,
      equipmentName: usage.equipment.name,
      totalSets: usage.totalSets,
      currentSet: usage.currentSet,
      setStatus: usage.setStatus,
      restSeconds: usage.restSeconds,
      startedAt: usage.startedAt,
      estimatedEndAt: usage.estimatedEndAt,
      progress: Math.round((usage.currentSet / usage.totalSets) * 100)
    })
    
  } catch (error) {
    console.error('start-using error:', error)
    res.status(500).json({ error: '기구 사용 시작 실패' })
  }
})

// 🔥 세트 완료 API (실시간 업데이트 포함)
router.post('/complete-set/:equipmentId', auth(), async (req, res) => {
  try {
    const equipmentId = parseInt(req.params.equipmentId)
    const usage = await prisma.equipmentUsage.findFirst({
      where: { equipmentId, userId: req.user.id, status: 'IN_USE' }, 
      include: { equipment: true, user: { select: { name: true } } }
    })
    
    if (!usage) return res.status(404).json({ error: '사용 중 아님' })
    if (usage.setStatus !== 'EXERCISING') {
      return res.status(400).json({ 
        error: 'EXERCISING 상태가 아님', 
        currentStatus: usage.setStatus 
      })
    }

    const isLastSet = usage.currentSet >= usage.totalSets
    
    if (isLastSet) {
      // 운동 완료
      await prisma.equipmentUsage.update({
        where: { id: usage.id }, 
        data: { 
          status: 'COMPLETED', 
          setStatus: 'COMPLETED', 
          endedAt: new Date() 
        }
      })
      
      // 🔥 완료 브로드캐스트
      broadcastEquipmentStatusChange(equipmentId, {
        type: 'usage_completed',
        equipmentName: usage.equipment.name,
        userName: usage.user.name,
        totalSets: usage.totalSets,
        completedAt: new Date()
      })
      
      // 자동 업데이트 중지
      stopAutoUpdate(equipmentId)
      
      // 다음 대기자 알림
      setTimeout(() => notifyNextUser(equipmentId), 1000)
      
      return res.json({ 
        message: `전체 ${usage.totalSets}세트 완료!`, 
        completed: true 
      })
    }

    // 휴식 시작
    await prisma.equipmentUsage.update({
      where: { id: usage.id }, 
      data: { 
        setStatus: 'RESTING', 
        restStartedAt: new Date() 
      }
    })

    // 🔥 휴식 시작 브로드캐스트
    broadcastEquipmentStatusChange(equipmentId, {
      type: 'rest_started',
      equipmentName: usage.equipment.name,
      userName: usage.user.name,
      currentSet: usage.currentSet,
      totalSets: usage.totalSets,
      restSeconds: usage.restSeconds
    })

    // 휴식 알림
    sendNotification(req.user.id, {
      type: 'REST_STARTED',
      title: '휴식 시작',
      message: `${usage.currentSet}/${usage.totalSets} 세트 완료`,
      equipmentId,
      restSeconds: usage.restSeconds
    })

    // 자동 다음 세트 시작
    if (usage.restSeconds > 0) {
      setTimeout(async () => {
        const current = await prisma.equipmentUsage.findUnique({ 
          where: { id: usage.id }, 
          include: { equipment: true, user: { select: { name: true } } } 
        })
        
        if (current && current.setStatus === 'RESTING' && current.status === 'IN_USE') {
          await prisma.equipmentUsage.update({
            where: { id: usage.id },
            data: { 
              currentSet: current.currentSet + 1, 
              setStatus: 'EXERCISING', 
              currentSetStartedAt: new Date(), 
              restStartedAt: null 
            }
          })
          
          // 🔥 다음 세트 시작 브로드캐스트
          broadcastEquipmentStatusChange(equipmentId, {
            type: 'next_set_started',
            equipmentName: current.equipment.name,
            userName: current.user.name,
            currentSet: current.currentSet + 1,
            totalSets: current.totalSets
          })
          
          sendNotification(req.user.id, {
            type: 'NEXT_SET_STARTED',
            title: '다음 세트',
            message: `${current.currentSet + 1}/${current.totalSets} 세트 시작`,
            equipmentId
          })
        }
      }, usage.restSeconds * 1000)
    }

    res.json({ 
      message: `${usage.currentSet}/${usage.totalSets} 세트 완료`, 
      setStatus: 'RESTING',
      restSeconds: usage.restSeconds
    })
    
  } catch (error) {
    console.error('complete-set error:', error)
    res.status(500).json({ error: '세트 완료 실패' })
  }
})

// 🔥 운동 중단 API (실시간 업데이트 포함)
router.post('/stop-exercise/:equipmentId', auth(), async (req, res) => {
  try {
    const equipmentId = parseInt(req.params.equipmentId)
    const usage = await prisma.equipmentUsage.findFirst({
      where: { equipmentId, userId: req.user.id, status: 'IN_USE' }, 
      include: { equipment: true, user: { select: { name: true } } }
    })
    
    if (!usage) return res.status(404).json({ error: '사용 중 아님' })

    await prisma.equipmentUsage.update({
      where: { id: usage.id }, 
      data: { 
        status: 'COMPLETED', 
        setStatus: 'STOPPED', 
        endedAt: new Date() 
      }
    })
    
    // 🔥 중단 브로드캐스트
    broadcastEquipmentStatusChange(equipmentId, {
      type: 'usage_stopped',
      equipmentName: usage.equipment.name,
      userName: usage.user.name,
      completedSets: usage.currentSet,
      totalSets: usage.totalSets,
      stoppedAt: new Date()
    })
    
    sendNotification(req.user.id, {
      type: 'EXERCISE_STOPPED',
      title: '운동 중단',
      message: `${usage.equipment.name} 운동 중단`,
      equipmentId
    })
    
    // 자동 업데이트 중지 및 다음 사용자 알림
    stopAutoUpdate(equipmentId)
    setTimeout(() => notifyNextUser(equipmentId), 1000)

    res.json({ message: '운동 중단 완료' })
    
  } catch (error) {
    console.error('stop-exercise error:', error)
    res.status(500).json({ error: '운동 중단 실패' })
  }
})

// 🔥 대기열 등록 API (실시간 업데이트 포함)
router.post('/queue/:equipmentId', auth(), async (req, res) => {
  try {
    const equipmentId = parseInt(req.params.equipmentId)
    const equipment = await prisma.equipment.findUnique({ where: { id: equipmentId } })
    if (!equipment) return res.status(404).json({ error: '기구 없음' })

    const existing = await prisma.waitingQueue.findFirst({
      where: { 
        equipmentId, 
        userId: req.user.id, 
        status: { in: ['WAITING', 'NOTIFIED'] } 
      }
    })
    
    if (existing) {
      return res.status(409).json({ 
        error: '이미 대기열 등록', 
        queuePosition: existing.queuePosition, 
        status: existing.status 
      })
    }

    const myUsage = await prisma.equipmentUsage.findFirst({ 
      where: { userId: req.user.id, status: 'IN_USE' } 
    })
    if (myUsage) return res.status(409).json({ error: '이미 다른 기구 사용 중' })

    const length = await prisma.waitingQueue.count({
      where: { equipmentId, status: { in: ['WAITING', 'NOTIFIED'] } }
    })
    
    const queue = await prisma.waitingQueue.create({
      data: { 
        equipmentId, 
        userId: req.user.id, 
        queuePosition: length + 1, 
        status: 'WAITING' 
      },
      include: { equipment: true, user: { select: { name: true } } }
    })

    // 🔥 대기열 등록 브로드캐스트
    broadcastEquipmentStatusChange(equipmentId, {
      type: 'queue_joined',
      equipmentName: equipment.name,
      userName: queue.user.name,
      queuePosition: queue.queuePosition,
      totalWaiting: length + 1
    })

    // 즉시 사용 가능한 경우 알림
    const currentUsage = await prisma.equipmentUsage.findFirst({ 
      where: { equipmentId, status: 'IN_USE' } 
    })
    
    if (!currentUsage && queue.queuePosition === 1) {
      setTimeout(() => notifyNextUser(equipmentId), 1000)
    } else if (currentUsage) {
      // 자동 업데이트 시작 (아직 시작되지 않았다면)
      startAutoUpdate(equipmentId)
    }

    res.status(201).json({
      id: queue.id,
      queuePosition: queue.queuePosition,
      equipmentId,
      equipmentName: queue.equipment.name,
      status: queue.status,
      estimatedWaitMinutes: length * 15 // 간단한 예상 시간
    })
    
  } catch (error) {
    console.error('queue add error:', error)
    res.status(500).json({ error: '대기열 등록 실패' })
  }
})

// ====== 유틸리티 함수들 ======

async function reorderQueue(equipmentId) {
  const rows = await prisma.waitingQueue.findMany({
    where: { equipmentId, status: { in: ['WAITING', 'NOTIFIED'] } },
    orderBy: { createdAt: 'asc' },
  })
  
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].queuePosition !== i + 1) {
      await prisma.waitingQueue.update({
        where: { id: rows[i].id },
        data: { queuePosition: i + 1 },
      })
    }
  }
  
  return rows.length
}

async function notifyNextUser(equipmentId) {
  const next = await prisma.waitingQueue.findFirst({
    where: { equipmentId, status: 'WAITING' },
    orderBy: { queuePosition: 'asc' },
    include: { user: true, equipment: true },
  })
  
  if (!next) return false

  await prisma.waitingQueue.update({
    where: { id: next.id },
    data: { status: 'NOTIFIED', notifiedAt: new Date() },
  })

  // 🔥 다음 사용자 알림 (개선된 버전)
  sendNotification(next.userId, {
    type: 'EQUIPMENT_AVAILABLE',
    title: '기구 사용 가능',
    message: `${next.equipment.name}을 사용할 차례입니다`,
    equipmentId,
    equipmentName: next.equipment.name,
    queueId: next.id,
    graceMinutes: 5,
  })

  // 🔥 대기열 변경 브로드캐스트
  broadcastEquipmentStatusChange(equipmentId, {
    type: 'next_user_notified',
    equipmentName: next.equipment.name,
    nextUserName: next.user.name,
    queuePosition: next.queuePosition
  })

  // 5분 유예 타이머
  setTimeout(async () => {
    const fresh = await prisma.waitingQueue.findUnique({ where: { id: next.id } })
    if (fresh && fresh.status === 'NOTIFIED') {
      await prisma.waitingQueue.update({ 
        where: { id: next.id }, 
        data: { status: 'EXPIRED' } 
      })
      
      sendNotification(next.userId, {
        type: 'QUEUE_EXPIRED',
        title: '대기 만료',
        message: '시간 초과로 대기에서 제외되었습니다',
        equipmentId,
      })
      
      await reorderQueue(equipmentId)
      await notifyNextUser(equipmentId)
    }
  }, 5 * 60 * 1000)

  return true
}

// ====== 추가 API들 ======

// 실시간 상태 조회
router.get('/status/:equipmentId', async (req, res) => {
  try {
    const equipmentId = parseInt(req.params.equipmentId)
    const equipment = await prisma.equipment.findUnique({ where: { id: equipmentId } })
    if (!equipment) return res.status(404).json({ error: '기구를 찾을 수 없습니다' })

    const currentUsage = await prisma.equipmentUsage.findFirst({
      where: { equipmentId, status: 'IN_USE' },
      include: { user: { select: { name: true } } }
    })
    
    const queue = await prisma.waitingQueue.findMany({
      where: { equipmentId, status: { in: ['WAITING', 'NOTIFIED'] } },
      orderBy: { queuePosition: 'asc' },
      include: { user: { select: { name: true } } }
    })

    const currentETA = currentUsage ? calculateRealTimeETA(currentUsage) : 0
    const queueETAs = buildQueueETAs(currentETA, queue)

    let setProgress = null
    if (currentUsage && currentUsage.setStatus === 'EXERCISING' && currentUsage.currentSetStartedAt) {
      const elapsed = Date.now() - currentUsage.currentSetStartedAt.getTime()
      const estimatedSetTime = AVG_SET_MIN * 60 * 1000
      setProgress = Math.min(100, Math.round((elapsed / estimatedSetTime) * 100))
    }

    res.json({
      equipmentId,
      equipmentName: equipment.name,
      isAvailable: !currentUsage,
      lastUpdated: new Date(),
      currentUser: currentUsage ? {
        name: currentUsage.user.name,
        startedAt: currentUsage.startedAt,
        totalSets: currentUsage.totalSets,
        currentSet: currentUsage.currentSet,
        setStatus: currentUsage.setStatus,
        restSeconds: currentUsage.restSeconds,
        progress: Math.round((currentUsage.currentSet / currentUsage.totalSets) * 100),
        setProgress,
        estimatedMinutesLeft: currentETA,
        restTimeLeft: currentUsage.setStatus === 'RESTING' && currentUsage.restStartedAt ? 
          Math.max(0, Math.ceil((currentUsage.restSeconds * 1000 - (Date.now() - currentUsage.restStartedAt.getTime())) / 1000)) : 0
      } : null,
      waitingQueue: queue.map((q, i) => ({
        id: q.id,
        position: q.queuePosition,
        userName: q.user.name,
        status: q.status,
        createdAt: q.createdAt,
        notifiedAt: q.notifiedAt,
        estimatedWaitMinutes: queueETAs[i] || 0,
      })),
      totalWaiting: queue.length,
      averageWaitTime: queue.length ? Math.round(queueETAs.reduce((a, b) => a + b, 0) / queue.length) : 0,
    })
  } catch (error) {
    console.error('상태 조회 오류:', error)
    res.status(500).json({ error: '상태 조회에 실패했습니다' })
  }
})

// 시스템 통계
router.get('/admin/stats', auth(), async (req, res) => {
  try {
    const activeUsages = await prisma.equipmentUsage.count({ 
      where: { status: 'IN_USE' } 
    })
    
    const activeQueues = await prisma.waitingQueue.count({ 
      where: { status: { in: ['WAITING', 'NOTIFIED'] } } 
    })
    
    res.json({
      activeUsages,
      activeQueues,
      autoUpdateCount: autoUpdateIntervals.size,
      rateLimitedUsers: userUpdateLimiter.size,
      timestamp: new Date()
    })
  } catch (error) {
    console.error('통계 조회 오류:', error)
    res.status(500).json({ error: '통계 조회 실패' })
  }
})

module.exports = { router }