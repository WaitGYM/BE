const router = require('express').Router()
const { PrismaClient } = require('@prisma/client')
const { auth } = require('../middleware/auth')
const prisma = new PrismaClient()

// WebSocket 연결을 위한 클라이언트 저장소
const wsClients = new Map() // userId -> WebSocket

// WebSocket 클라이언트 등록
function registerWSClient(userId, ws) {
  wsClients.set(userId, ws)
  ws.on('close', () => wsClients.delete(userId))
}

// 실시간 알림 전송
function sendNotification(userId, data) {
  const ws = wsClients.get(userId)
  if (ws && ws.readyState === 1) { // WebSocket.OPEN
    ws.send(JSON.stringify(data))
  }
}

// 대기열 위치 재계산
async function reorderQueue(equipmentId) {
  const waitingUsers = await prisma.waitingQueue.findMany({
    where: { 
      equipmentId,
      status: { in: ['WAITING', 'NOTIFIED'] }
    },
    orderBy: { createdAt: 'asc' }
  })

  for (let i = 0; i < waitingUsers.length; i++) {
    await prisma.waitingQueue.update({
      where: { id: waitingUsers[i].id },
      data: { queuePosition: i + 1 }
    })
  }
}

// 다음 대기자에게 알림
async function notifyNextUser(equipmentId) {
  const nextUser = await prisma.waitingQueue.findFirst({
    where: { 
      equipmentId,
      status: 'WAITING'
    },
    orderBy: { queuePosition: 'asc' },
    include: {
      user: { select: { id: true, name: true } },
      equipment: { select: { name: true } }
    }
  })

  if (nextUser) {
    // 상태를 NOTIFIED로 변경
    await prisma.waitingQueue.update({
      where: { id: nextUser.id },
      data: { 
        status: 'NOTIFIED',
        notifiedAt: new Date()
      }
    })

    // 실시간 알림 전송
    sendNotification(nextUser.userId, {
      type: 'EQUIPMENT_AVAILABLE',
      message: `${nextUser.equipment.name} 기구를 사용할 수 있습니다! 5분 내에 시작해주세요.`,
      equipmentId,
      queueId: nextUser.id,
      graceMinutes: 5
    })

    // 5분 후 자동 취소 타이머 설정
    setTimeout(async () => {
      try {
        const queue = await prisma.waitingQueue.findUnique({
          where: { id: nextUser.id }
        })
        
        if (queue && queue.status === 'NOTIFIED') {
          // 시간 초과로 자동 취소
          await prisma.waitingQueue.update({
            where: { id: nextUser.id },
            data: { status: 'EXPIRED' }
          })

          sendNotification(nextUser.userId, {
            type: 'QUEUE_EXPIRED',
            message: '시간이 초과되어 대기열에서 제거되었습니다.',
            equipmentId
          })

          // 대기열 재정렬 후 다음 사람에게 알림
          await reorderQueue(equipmentId)
          await notifyNextUser(equipmentId)
        }
      } catch (error) {
        console.error('Auto-cancel error:', error)
      }
    }, 5 * 60 * 1000) // 5분
  }
}

// 기구 사용 시작
router.post('/start-using/:equipmentId', auth(), async (req, res) => {
  try {
    const equipmentId = Number(req.params.equipmentId)
    const { sets = 1, restMinutes = 3 } = req.body

    // 이미 사용 중인 기구인지 확인
    const currentUsage = await prisma.equipmentUsage.findFirst({
      where: { equipmentId, status: 'IN_USE' }
    })

    if (currentUsage) {
      return res.status(409).json({ error: '이미 사용 중인 기구입니다' })
    }

    // 사용자가 이 기구의 1순위 대기자인지 확인
    const firstInQueue = await prisma.waitingQueue.findFirst({
      where: { 
        equipmentId,
        status: { in: ['WAITING', 'NOTIFIED'] }
      },
      orderBy: { queuePosition: 'asc' }
    })

    // 대기열이 있는데 본인이 1순위가 아니면 거부
    if (firstInQueue && firstInQueue.userId !== req.user.id) {
      return res.status(403).json({ 
        error: '대기 순서가 아닙니다',
        queuePosition: firstInQueue.queuePosition
      })
    }

    // 기구 사용 시작
    const usage = await prisma.equipmentUsage.create({
      data: {
        equipmentId,
        userId: req.user.id,
        sets,
        restMinutes,
        status: 'IN_USE'
      }
    })

    // 본인이 1순위였다면 대기열에서 제거
    if (firstInQueue && firstInQueue.userId === req.user.id) {
      await prisma.waitingQueue.update({
        where: { id: firstInQueue.id },
        data: { status: 'COMPLETED' }
      })
      
      // 대기열 재정렬
      await reorderQueue(equipmentId)
    }

    res.status(201).json(usage)
  } catch (error) {
    console.error('기구 사용 시작 오류:', error)
    res.status(500).json({ error: '기구 사용 시작에 실패했습니다' })
  }
})

// 기구 사용 완료
router.post('/finish-using/:equipmentId', auth(), async (req, res) => {
  try {
    const equipmentId = Number(req.params.equipmentId)

    // 현재 사용 중인 기구 찾기
    const usage = await prisma.equipmentUsage.findFirst({
      where: { 
        equipmentId, 
        userId: req.user.id,
        status: 'IN_USE' 
      }
    })

    if (!usage) {
      return res.status(404).json({ error: '사용 중인 기구를 찾을 수 없습니다' })
    }

    // 사용 완료 처리
    await prisma.equipmentUsage.update({
      where: { id: usage.id },
      data: { 
        status: 'COMPLETED',
        endedAt: new Date()
      }
    })

    // 다음 대기자에게 알림
    await notifyNextUser(equipmentId)

    res.json({ message: '기구 사용이 완료되었습니다' })
  } catch (error) {
    console.error('기구 사용 완료 오류:', error)
    res.status(500).json({ error: '기구 사용 완료에 실패했습니다' })
  }
})

// 대기열 등록
router.post('/queue/:equipmentId', auth(), async (req, res) => {
  try {
    const equipmentId = Number(req.params.equipmentId)

    // 기구 존재 확인
    const equipment = await prisma.equipment.findUnique({
      where: { id: equipmentId }
    })
    if (!equipment) {
      return res.status(404).json({ error: '기구를 찾을 수 없습니다' })
    }

    // 이미 대기 중인지 확인
    const existing = await prisma.waitingQueue.findFirst({
      where: { 
        equipmentId,
        userId: req.user.id,
        status: { in: ['WAITING', 'NOTIFIED'] }
      }
    })

    if (existing) {
      return res.status(409).json({ 
        error: '이미 대기열에 등록되어 있습니다',
        queuePosition: existing.queuePosition
      })
    }

    // 현재 대기열 길이 확인
    const queueLength = await prisma.waitingQueue.count({
      where: { 
        equipmentId,
        status: { in: ['WAITING', 'NOTIFIED'] }
      }
    })

    // 대기열 등록
    const queue = await prisma.waitingQueue.create({
      data: {
        equipmentId,
        userId: req.user.id,
        queuePosition: queueLength + 1,
        status: 'WAITING'
      }
    })

    // 기구가 비어있고 첫 번째 대기자라면 즉시 알림
    const currentUsage = await prisma.equipmentUsage.findFirst({
      where: { equipmentId, status: 'IN_USE' }
    })

    if (!currentUsage && queue.queuePosition === 1) {
      await notifyNextUser(equipmentId)
    }

    res.status(201).json({
      id: queue.id,
      queuePosition: queue.queuePosition,
      equipmentId,
      status: queue.status
    })
  } catch (error) {
    console.error('대기열 등록 오류:', error)
    res.status(500).json({ error: '대기열 등록에 실패했습니다' })
  }
})

// 대기열 취소
router.delete('/queue/:queueId', auth(), async (req, res) => {
  try {
    const queueId = Number(req.params.queueId)

    const queue = await prisma.waitingQueue.findUnique({
      where: { id: queueId }
    })

    if (!queue) {
      return res.status(404).json({ error: '대기열을 찾을 수 없습니다' })
    }

    if (queue.userId !== req.user.id) {
      return res.status(403).json({ error: '권한이 없습니다' })
    }

    // 대기열에서 제거
    await prisma.waitingQueue.update({
      where: { id: queueId },
      data: { status: 'CANCELLED' }
    })

    // 대기열 재정렬
    await reorderQueue(queue.equipmentId)

    res.status(204).end()
  } catch (error) {
    console.error('대기열 취소 오류:', error)
    res.status(500).json({ error: '대기열 취소에 실패했습니다' })
  }
})

// 기구별 현재 상태 조회
router.get('/status/:equipmentId', async (req, res) => {
  try {
    const equipmentId = Number(req.params.equipmentId)

    // 현재 사용자
    const currentUsage = await prisma.equipmentUsage.findFirst({
      where: { equipmentId, status: 'IN_USE' },
      include: {
        user: { select: { name: true } }
      }
    })

    // 대기열
    const queue = await prisma.waitingQueue.findMany({
      where: { 
        equipmentId,
        status: { in: ['WAITING', 'NOTIFIED'] }
      },
      orderBy: { queuePosition: 'asc' },
      include: {
        user: { select: { name: true } }
      }
    })

    res.json({
      equipmentId,
      currentUser: currentUsage ? {
        name: currentUsage.user.name,
        startedAt: currentUsage.startedAt,
        sets: currentUsage.sets,
        restMinutes: currentUsage.restMinutes
      } : null,
      waitingQueue: queue.map(q => ({
        id: q.id,
        position: q.queuePosition,
        userName: q.user.name,
        status: q.status,
        createdAt: q.createdAt,
        notifiedAt: q.notifiedAt
      })),
      totalWaiting: queue.length
    })
  } catch (error) {
    console.error('상태 조회 오류:', error)
    res.status(500).json({ error: '상태 조회에 실패했습니다' })
  }
})

// 내 대기열 현황
router.get('/my-queues', auth(), async (req, res) => {
  try {
    const queues = await prisma.waitingQueue.findMany({
      where: { 
        userId: req.user.id,
        status: { in: ['WAITING', 'NOTIFIED'] }
      },
      include: {
        equipment: true
      },
      orderBy: { createdAt: 'desc' }
    })

    res.json(queues.map(q => ({
      id: q.id,
      position: q.queuePosition,
      status: q.status,
      createdAt: q.createdAt,
      notifiedAt: q.notifiedAt,
      equipment: {
        id: q.equipment.id,
        name: q.equipment.name,
        category: q.equipment.category
      }
    })))
  } catch (error) {
    console.error('내 대기열 조회 오류:', error)
    res.status(500).json({ error: '대기열 조회에 실패했습니다' })
  }
})

// WebSocket 클라이언트 등록 함수 export
module.exports = { router, registerWSClient }