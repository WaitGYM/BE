// src/routes/waiting.js
const router = require('express').Router()
const { PrismaClient } = require('@prisma/client')
const { auth } = require('../middleware/auth')
const { sendNotification } = require('../websocket')
const { z } = require('zod')

const prisma = new PrismaClient()

// ====== 입력 검증 ======
const startUsingSchema = z.object({
  totalSets: z.number().int().min(1).max(20).default(3),
  restMinutes: z.number().int().min(0).max(10).default(3),
})

// ====== 공통 유틸/헬퍼 ======
const toInt = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN)

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

  sendNotification(next.userId, {
    type: 'EQUIPMENT_AVAILABLE',
    title: '기구 사용 가능',
    message: `${next.equipment.name}을 사용할 차례입니다. 5분 내 시작해주세요`,
    equipmentId,
    equipmentName: next.equipment.name,
    queueId: next.id,
    graceMinutes: 5,
  })

  // 5분 유예 뒤 자동 만료
  setTimeout(async () => {
    const fresh = await prisma.waitingQueue.findUnique({ where: { id: next.id } })
    if (fresh && fresh.status === 'NOTIFIED') {
      await prisma.waitingQueue.update({ where: { id: next.id }, data: { status: 'EXPIRED' } })
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

// ====== ETA 계산(정밀) - totalSets 기준 ======
const AVG_SET_MIN = 5 // 기본 세트 시간(분), 필요 시 장비별 통계로 교체

function msLeft(now, since, total) {
  if (!since) return total
  const elapsed = now - since.getTime()
  return Math.max(0, total - elapsed)
}
function estimateCurrentUsageMinutes(usage) {
  const now = Date.now()
  const setMs = AVG_SET_MIN * 60 * 1000
  const restMs = (usage.restMinutes || 0) * 60 * 1000
  const remainingSets = Math.max(0, usage.totalSets - usage.currentSet)

  if (usage.setStatus === 'EXERCISING') {
    const thisSetLeft = msLeft(now, usage.currentSetStartedAt, setMs)
    if (remainingSets === 0) return Math.ceil(thisSetLeft / 60000)
    const tail = (remainingSets - 1) * (setMs + restMs) + setMs
    return Math.ceil((thisSetLeft + tail) / 60000)
  }
  if (usage.setStatus === 'RESTING') {
    const thisRestLeft = msLeft(now, usage.restStartedAt, restMs)
    const k = remainingSets + 1 // 휴식 뒤 시작할 세트 포함
    const work = k * setMs
    const rests = (k - 1) * restMs
    return Math.ceil((thisRestLeft + work + rests) / 60000)
  }
  return 0
}
function buildQueueETAs(currentLeftMin, queue, perPersonAvg = 15, grace = 5) {
  const etas = []
  let acc = currentLeftMin
  for (let i = 0; i < queue.length; i++) {
    if (i === 0) etas.push(acc + grace)
    else { acc = etas[i - 1] + perPersonAvg; etas.push(acc) }
  }
  return etas
}

// ========================
// 🏋 핵심 운동 관리 API
// ========================
router.post('/start-using/:equipmentId', auth(), async (req, res) => {
  try {
    const equipmentId = toInt(req.params.equipmentId)
    if (!Number.isFinite(equipmentId) || equipmentId < 1) return res.status(400).json({ error: '올바른 기구 ID 필요' })

    const parse = startUsingSchema.safeParse(req.body)
    if (!parse.success) return res.status(400).json({ error: '입력 형식 오류', details: parse.error.issues })
    const { totalSets, restMinutes } = parse.data

    const equipment = await prisma.equipment.findUnique({ where: { id: equipmentId } })
    if (!equipment) return res.status(404).json({ error: '기구 없음' })

    const currentUsage = await prisma.equipmentUsage.findFirst({
      where: { equipmentId, status: 'IN_USE' }, include: { user: true }
    })
    if (currentUsage) {
      return res.status(409).json({ error: '이미 사용 중', currentUser: currentUsage.user.name, since: currentUsage.startedAt })
    }

    const myUsage = await prisma.equipmentUsage.findFirst({
      where: { userId: req.user.id, status: 'IN_USE' }, include: { equipment: true }
    })
    if (myUsage) return res.status(409).json({ error: '다른 기구 사용 중', currentEquipment: myUsage.equipment.name, equipmentId: myUsage.equipmentId })

    const firstInQueue = await prisma.waitingQueue.findFirst({
      where: { equipmentId, status: { in: ['WAITING', 'NOTIFIED'] } }, orderBy: { queuePosition: 'asc' }
    })
    if (firstInQueue && firstInQueue.userId !== req.user.id) {
      const mine = await prisma.waitingQueue.findFirst({
        where: { equipmentId, userId: req.user.id, status: { in: ['WAITING', 'NOTIFIED'] } }
      })
      return res.status(403).json({ error: '대기 순서가 아님', yourPosition: mine?.queuePosition ?? null, firstPosition: firstInQueue.queuePosition })
    }

    const usage = await prisma.$transaction(async (tx) => {
      const u = await tx.equipmentUsage.create({
        data: {
          equipmentId,
          userId: req.user.id,
          totalSets,
          currentSet: 1,
          restMinutes,
          status: 'IN_USE',
          setStatus: 'EXERCISING',
          currentSetStartedAt: new Date(),
          estimatedEndAt:
            totalSets === 1
              ? new Date(Date.now() + 10 * 60 * 1000)
              : new Date(Date.now() + ((totalSets * 5) + ((totalSets - 1) * restMinutes)) * 60 * 1000),
        },
        include: { equipment: true, user: { select: { name: true, email: true } } },
      })
      if (firstInQueue && firstInQueue.userId === req.user.id) {
        await tx.waitingQueue.update({ where: { id: firstInQueue.id }, data: { status: 'COMPLETED' } })
      }
      return u
    })

    if (firstInQueue && firstInQueue.userId === req.user.id) setImmediate(() => reorderQueue(equipmentId))

    res.status(201).json({
      id: usage.id,
      equipmentId: usage.equipmentId,
      equipmentName: usage.equipment.name,
      totalSets: usage.totalSets,
      currentSet: usage.currentSet,
      setStatus: usage.setStatus,
      restMinutes: usage.restMinutes,
      startedAt: usage.startedAt,
      currentSetStartedAt: usage.currentSetStartedAt,
      estimatedEndAt: usage.estimatedEndAt,
      progress: Math.round((usage.currentSet / usage.totalSets) * 100),
    })
  } catch (e) {
    console.error('start-using error:', e)
    res.status(500).json({ error: '기구 사용 시작 실패' })
  }
})

router.post('/complete-set/:equipmentId', auth(), async (req, res) => {
  try {
    const equipmentId = toInt(req.params.equipmentId)
    const usage = await prisma.equipmentUsage.findFirst({
      where: { equipmentId, userId: req.user.id, status: 'IN_USE' }, include: { equipment: true }
    })
    if (!usage) return res.status(404).json({ error: '사용 중 아님' })
    if (usage.setStatus !== 'EXERCISING') return res.status(400).json({ error: 'EXERCISING 상태가 아님', currentStatus: usage.setStatus })

    const isLastSet = usage.currentSet >= usage.totalSets
    if (isLastSet) {
      await prisma.equipmentUsage.update({
        where: { id: usage.id }, data: { status: 'COMPLETED', setStatus: 'COMPLETED', endedAt: new Date() }
      })
      setImmediate(() => notifyNextUser(equipmentId).catch(console.error))
      return res.json({ message: `전체 ${usage.totalSets}세트 완료!`, completed: true })
    }

    await prisma.equipmentUsage.update({
      where: { id: usage.id }, data: { setStatus: 'RESTING', restStartedAt: new Date() }
    })

    sendNotification(req.user.id, {
      type: 'REST_STARTED',
      title: '휴식 시작',
      message: `${usage.currentSet}/${usage.totalSets} 세트 완료. ${usage.restMinutes}분 휴식`,
      equipmentId
    })

    if (usage.restMinutes > 0) {
      setTimeout(async () => {
        const current = await prisma.equipmentUsage.findUnique({ where: { id: usage.id }, include: { equipment: true } })
        if (current && current.setStatus === 'RESTING' && current.status === 'IN_USE') {
          await prisma.equipmentUsage.update({
            where: { id: usage.id },
            data: { currentSet: current.currentSet + 1, setStatus: 'EXERCISING', currentSetStartedAt: new Date(), restStartedAt: null }
          })
          sendNotification(req.user.id, {
            type: 'NEXT_SET_STARTED',
            title: '다음 세트',
            message: `${current.currentSet + 1}/${usage.totalSets} 세트 시작`,
            equipmentId
          })
        }
      }, usage.restMinutes * 60 * 1000)
    }

    res.json({ message: `${usage.currentSet}/${usage.totalSets} 세트 완료`, setStatus: 'RESTING' })
  } catch (e) {
    console.error('complete-set error:', e)
    res.status(500).json({ error: '세트 완료 실패' })
  }
})

router.post('/skip-rest/:equipmentId', auth(), async (req, res) => {
  try {
    const equipmentId = toInt(req.params.equipmentId)
    const usage = await prisma.equipmentUsage.findFirst({
      where: { equipmentId, userId: req.user.id, status: 'IN_USE' }, include: { equipment: true }
    })
    if (!usage) return res.status(404).json({ error: '사용 중 아님' })
    if (usage.setStatus !== 'RESTING') return res.status(400).json({ error: 'RESTING 상태가 아님', currentStatus: usage.setStatus })
    if (usage.currentSet >= usage.totalSets) return res.status(400).json({ error: '이미 모든 세트 완료' })

    const updated = await prisma.equipmentUsage.update({
      where: { id: usage.id },
      data: { currentSet: usage.currentSet + 1, setStatus: 'EXERCISING', currentSetStartedAt: new Date(), restStartedAt: null }
    })
    sendNotification(req.user.id, {
      type: 'SET_SKIPPED',
      title: '휴식 스킵',
      message: `${updated.currentSet}/${usage.totalSets} 세트 시작`,
      equipmentId
    })

    res.json({ message: `${updated.currentSet}/${usage.totalSets} 세트 시작`, setStatus: 'EXERCISING' })
  } catch (e) {
    console.error('skip-rest error:', e)
    res.status(500).json({ error: '휴식 스킵 실패' })
  }
})

router.post('/stop-exercise/:equipmentId', auth(), async (req, res) => {
  try {
    const equipmentId = toInt(req.params.equipmentId)
    const usage = await prisma.equipmentUsage.findFirst({
      where: { equipmentId, userId: req.user.id, status: 'IN_USE' }, include: { equipment: true }
    })
    if (!usage) return res.status(404).json({ error: '사용 중 아님' })

    await prisma.equipmentUsage.update({
      where: { id: usage.id }, data: { status: 'COMPLETED', setStatus: 'STOPPED', endedAt: new Date() }
    })
    sendNotification(req.user.id, {
      type: 'EXERCISE_STOPPED',
      title: '운동 중단',
      message: `${usage.equipment.name} 운동 중단`,
      equipmentId
    })
    setImmediate(() => notifyNextUser(equipmentId).catch(console.error))

    res.json({ message: '운동 중단 완료' })
  } catch (e) {
    console.error('stop-exercise error:', e)
    res.status(500).json({ error: '운동 중단 실패' })
  }
})

router.get('/exercise-status/:equipmentId', auth(), async (req, res) => {
  try {
    const equipmentId = toInt(req.params.equipmentId)
    const usage = await prisma.equipmentUsage.findFirst({
      where: { equipmentId, userId: req.user.id, status: 'IN_USE' },
      include: { equipment: { select: { name: true } } }
    })
    if (!usage) return res.status(404).json({ error: '사용 중 아님' })

    let restTimeLeft = 0
    if (usage.setStatus === 'RESTING' && usage.restStartedAt) {
      const restElapsed = Date.now() - usage.restStartedAt.getTime()
      const totalRestMs = usage.restMinutes * 60 * 1000
      restTimeLeft = Math.max(0, totalRestMs - restElapsed)
    }

    const currentSetElapsed = usage.currentSetStartedAt ? Date.now() - usage.currentSetStartedAt.getTime() : 0
    const etaMinutes = estimateCurrentUsageMinutes(usage)

    res.json({
      equipmentId: usage.equipmentId,
      equipmentName: usage.equipment.name,
      totalSets: usage.totalSets,
      currentSet: usage.currentSet,
      setStatus: usage.setStatus,
      restMinutes: usage.restMinutes,
      restTimeLeftSec: Math.ceil(restTimeLeft / 1000),
      currentSetElapsedSec: Math.floor(currentSetElapsed / 1000),
      etaMinutes,
      progress: Math.round((usage.currentSet / usage.totalSets) * 100),
    })
  } catch (e) {
    console.error('exercise-status error:', e)
    res.status(500).json({ error: '상태 조회 실패' })
  }
})

// ====================
// 📝 대기열 관리 API
// ====================
router.post('/queue/:equipmentId', auth(), async (req, res) => {
  try {
    const equipmentId = toInt(req.params.equipmentId)
    const equipment = await prisma.equipment.findUnique({ where: { id: equipmentId } })
    if (!equipment) return res.status(404).json({ error: '기구 없음' })

    const existing = await prisma.waitingQueue.findFirst({
      where: { equipmentId, userId: req.user.id, status: { in: ['WAITING', 'NOTIFIED'] } }
    })
    if (existing) return res.status(409).json({ error: '이미 대기열 등록', queuePosition: existing.queuePosition, status: existing.status })

    const myUsage = await prisma.equipmentUsage.findFirst({ where: { userId: req.user.id, status: 'IN_USE' } })
    if (myUsage) return res.status(409).json({ error: '이미 다른 기구 사용 중' })

    const length = await prisma.waitingQueue.count({
      where: { equipmentId, status: { in: ['WAITING', 'NOTIFIED'] } }
    })
    const queue = await prisma.waitingQueue.create({
      data: { equipmentId, userId: req.user.id, queuePosition: length + 1, status: 'WAITING' },
      include: { equipment: true }
    })

    const currentUsage = await prisma.equipmentUsage.findFirst({ where: { equipmentId, status: 'IN_USE' } })
    if (!currentUsage && queue.queuePosition === 1) setImmediate(() => notifyNextUser(equipmentId))

    res.status(201).json({
      id: queue.id,
      queuePosition: queue.queuePosition,
      equipmentId,
      equipmentName: queue.equipment.name,
      status: queue.status
    })
  } catch (e) {
    console.error('queue add error:', e)
    res.status(500).json({ error: '대기열 등록 실패' })
  }
})

router.delete('/queue/:queueId', auth(), async (req, res) => {
  try {
    const queueId = toInt(req.params.queueId)
    const queue = await prisma.waitingQueue.findUnique({
      where: { id: queueId }, include: { equipment: true }
    })
    if (!queue) return res.status(404).json({ error: '대기열 없음' })
    if (queue.userId !== req.user.id) return res.status(403).json({ error: '권한 없음' })
    if (!['WAITING', 'NOTIFIED'].includes(queue.status)) return res.status(400).json({ error: '취소 불가 상태', status: queue.status })

    await prisma.waitingQueue.update({ where: { id: queueId }, data: { status: 'CANCELLED' } })
    sendNotification(req.user.id, {
      type: 'QUEUE_CANCELLED',
      title: '대기 취소',
      message: `${queue.equipment.name} 대기 취소`,
      equipmentId: queue.equipmentId
    })
    setImmediate(() => reorderQueue(queue.equipmentId))

    res.status(204).end()
  } catch (e) {
    console.error('queue cancel error:', e)
    res.status(500).json({ error: '대기열 취소 실패' })
  }
})

router.get('/status/:equipmentId', async (req, res) => {
  try {
    const equipmentId = toInt(req.params.equipmentId)
    const equipment = await prisma.equipment.findUnique({ where: { id: equipmentId } })
    if (!equipment) return res.status(404).json({ error: '기구 없음' })

    const currentUsage = await prisma.equipmentUsage.findFirst({
      where: { equipmentId, status: 'IN_USE' },
      include: { user: { select: { name: true } } }
    })
    const queue = await prisma.waitingQueue.findMany({
      where: { equipmentId, status: { in: ['WAITING', 'NOTIFIED'] } },
      orderBy: { queuePosition: 'asc' },
      include: { user: { select: { name: true } } }
    })

    let currentLeft = 0
    if (currentUsage) currentLeft = estimateCurrentUsageMinutes(currentUsage)
    const etas = buildQueueETAs(currentLeft, queue, 15, 5)

    res.json({
      equipmentId,
      equipmentName: equipment.name,
      isAvailable: !currentUsage,
      currentUser: currentUsage ? {
        name: currentUsage.user.name,
        startedAt: currentUsage.startedAt,
        totalSets: currentUsage.totalSets,
        currentSet: currentUsage.currentSet,
        setStatus: currentUsage.setStatus,
        restMinutes: currentUsage.restMinutes,
        progress: Math.round((currentUsage.currentSet / currentUsage.totalSets) * 100),
        estimatedEndAt: currentUsage.estimatedEndAt,
        // (선택) 현재 사용자 잔여 ETA
        estimatedWaitMinutes: currentLeft,
      } : null,
      waitingQueue: queue.map((q, i) => ({
        id: q.id,
        position: q.queuePosition,
        userName: q.user.name,
        status: q.status,
        createdAt: q.createdAt,
        notifiedAt: q.notifiedAt,
        // 네가 쓰던 키 이름 유지
        estimatedWaitMinutes: etas[i] || 0,
      })),
      totalWaiting: queue.length,
      averageWaitTime: queue.length ? etas[etas.length - 1] : 0,
    })
  } catch (e) {
    console.error('status error:', e)
    res.status(500).json({ error: '상태 조회 실패' })
  }
})

// ===================
// 🔧 관리자 기능
// ===================
router.post('/reorder/:equipmentId', auth(), async (req, res) => {
  try {
    const equipmentId = toInt(req.params.equipmentId)
    const count = await reorderQueue(equipmentId)
    res.json({ message: '대기열 재정렬 완료', reorderedCount: count })
  } catch (e) {
    console.error('reorder error:', e)
    res.status(500).json({ error: '재정렬 실패' })
  }
})

router.post('/force-complete/:equipmentId', auth(), async (req, res) => {
  try {
    const equipmentId = toInt(req.params.equipmentId)
    const usage = await prisma.equipmentUsage.findFirst({
      where: { equipmentId, status: 'IN_USE' },
      include: { equipment: true, user: { select: { name: true, email: true } } }
    })
    if (!usage) return res.status(404).json({ error: '사용 중 없음' })

    await prisma.equipmentUsage.update({
      where: { id: usage.id },
      data: { status: 'COMPLETED', setStatus: 'FORCE_COMPLETED', endedAt: new Date() }
    })
    sendNotification(usage.userId, {
      type: 'FORCE_COMPLETED',
      title: '관리자 완료',
      message: `${usage.equipment.name} 사용이 관리자에 의해 완료됨`,
      equipmentId
    })
    setImmediate(() => notifyNextUser(equipmentId).catch(console.error))

    res.json({ message: '강제 완료 처리', user: usage.user.name, equipment: usage.equipment.name })
  } catch (e) {
    console.error('force-complete error:', e)
    res.status(500).json({ error: '강제 완료 실패' })
  }
})

router.get('/stats', auth(), async (req, res) => {
  try {
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const weekStart = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000)

    const todayStats = await prisma.equipmentUsage.aggregate({
      where: { startedAt: { gte: todayStart }, status: 'COMPLETED' },
      _count: { id: true }, _avg: { totalSets: true }
    })
    const weekStats = await prisma.equipmentUsage.aggregate({
      where: { startedAt: { gte: weekStart }, status: 'COMPLETED' },
      _count: { id: true }
    })

    const popular = await prisma.equipmentUsage.groupBy({
      by: ['equipmentId'],
      where: { startedAt: { gte: weekStart }, status: 'COMPLETED' },
      _count: { equipmentId: true },
      orderBy: { _count: { equipmentId: 'desc' } },
      take: 5
    })
    const names = await prisma.equipment.findMany({
      where: { id: { in: popular.map(p => p.equipmentId) } },
      select: { id: true, name: true }
    })

    const activeUsers = await prisma.equipmentUsage.count({ where: { status: 'IN_USE' } })
    const waitingUsers = await prisma.waitingQueue.count({ where: { status: { in: ['WAITING', 'NOTIFIED'] } } })

    res.json({
      today: { totalSessions: todayStats._count.id || 0, averageSets: Math.round(todayStats._avg.totalSets || 0) },
      week: { totalSessions: weekStats._count.id || 0 },
      current: { activeUsers, waitingUsers, totalUsers: activeUsers + waitingUsers },
      popularEquipment: popular.map(p => ({
        equipmentId: p.equipmentId,
        equipmentName: names.find(n => n.id === p.equipmentId)?.name || 'Unknown',
        usageCount: p._count.equipmentId
      })),
    })
  } catch (e) {
    console.error('stats error:', e)
    res.status(500).json({ error: '통계 조회 실패' })
  }
})

router.post('/cleanup', auth(), async (req, res) => {
  try {
    const now = Date.now()
    const expired = await prisma.waitingQueue.updateMany({
      where: { status: 'NOTIFIED', notifiedAt: { lt: new Date(now - 10 * 60 * 1000) } },
      data: { status: 'EXPIRED' }
    })
    const oldRecords = await prisma.equipmentUsage.count({
      where: { status: 'COMPLETED', endedAt: { lt: new Date(now - 24 * 60 * 60 * 1000) } }
    })
    res.json({ message: '정리 완료', expiredQueues: expired.count, oldRecords })
  } catch (e) {
    console.error('cleanup error:', e)
    res.status(500).json({ error: '정리 작업 실패' })
  }
})

module.exports = { router }
