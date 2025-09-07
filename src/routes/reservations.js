const router = require('express').Router()
const { PrismaClient } = require('@prisma/client')
const { auth } = require('../middleware/auth')
const { z } = require('zod')
const prisma = new PrismaClient()

const resvSchema = z.object({
  equipmentId: z.number().int().positive(),
  startAt: z.string().datetime(),
  endAt: z.string().datetime()
}).refine(d => new Date(d.endAt) > new Date(d.startAt), { message: 'endAt > startAt' })

async function hasOverlap(equipmentId, startAt, endAt, excludeId) {
  return !!(await prisma.reservation.findFirst({
    where: {
      equipmentId,
      NOT: excludeId ? { id: excludeId } : undefined,
      startAt: { lt: endAt },
      endAt:   { gt: startAt }
    }
  }))
}

// 생성
// 예약 생성 부분 수정 (기존 POST '/' 라우트 교체)
router.post('/', auth(), async (req, res) => {
  const parse = resvSchema.safeParse({
    ...req.body,
    equipmentId: Number(req.body.equipmentId)
  })
  if (!parse.success) return res.status(400).json({ error: '입력 형식 오류' })
  const { equipmentId, startAt, endAt } = parse.data

  const s = new Date(startAt); const e = new Date(endAt)
  if (await hasOverlap(equipmentId, s, e)) return res.status(409).json({ error: '시간 중복' })

  try {
    // 예약 생성
    const created = await prisma.reservation.create({
      data: { equipmentId, userId: req.user.id, startAt: s, endAt: e },
      include: {
        equipment: true,
        user: {
          select: { id: true, name: true, email: true }
        }
      }
    })

    // 실시간 알림 전송
    req.notificationService.notifyNewReservation(
      created,
      created.equipment,
      created.user
    )

    res.status(201).json(created)
  } catch (error) {
    console.error('Reservation creation error:', error)
    res.status(500).json({ error: '예약 생성 실패' })
  }
})

// 내 예약 목록
router.get('/me', auth(), async (req, res) => {
  const list = await prisma.reservation.findMany({
    where: { userId: req.user.id },
    orderBy: { startAt: 'desc' },
    include: { equipment: true }
  })
  res.json(list)
})

// 단건 조회
router.get('/:id', auth(), async (req, res) => {
  const id = Number(req.params.id)
  const r = await prisma.reservation.findUnique({ where: { id } })
  if (!r) return res.status(404).json({ error: '없음' })
  if (r.userId !== req.user.id && req.user.role !== 'ADMIN') return res.status(403).json({ error: '권한 없음' })
  res.json(r)
})

// 수정
router.put('/:id', auth(), async (req, res) => {
  const id = Number(req.params.id)
  const parse = resvSchema.partial().safeParse({
    ...req.body,
    equipmentId: req.body.equipmentId ? Number(req.body.equipmentId) : undefined
  })
  if (!parse.success) return res.status(400).json({ error: '입력 형식 오류' })
  const prev = await prisma.reservation.findUnique({ where: { id } })
  if (!prev) return res.status(404).json({ error: '없음' })
  if (prev.userId !== req.user.id && req.user.role !== 'ADMIN') return res.status(403).json({ error: '권한 없음' })

  const nextData = {
    equipmentId: parse.data.equipmentId ?? prev.equipmentId,
    startAt: parse.data.startAt ? new Date(parse.data.startAt) : prev.startAt,
    endAt:   parse.data.endAt   ? new Date(parse.data.endAt)   : prev.endAt
  }
  if (await hasOverlap(nextData.equipmentId, nextData.startAt, nextData.endAt, id)) {
    return res.status(409).json({ error: '시간 중복' })
  }
  const updated = await prisma.reservation.update({ where: { id }, data: nextData })
  res.json(updated)
})

// 삭제
// 예약 삭제 부분 수정 (기존 DELETE '/:id' 라우트 교체)
router.delete('/:id', auth(), async (req, res) => {
  const id = Number(req.params.id)
  
  try {
    // 삭제 전에 예약 정보 조회 (알림용)
    const prev = await prisma.reservation.findUnique({ 
      where: { id },
      include: {
        equipment: true,
        user: {
          select: { id: true, name: true, email: true }
        }
      }
    })
    
    if (!prev) return res.status(404).json({ error: '없음' })
    if (prev.userId !== req.user.id && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: '권한 없음' })
    }

    // 예약 삭제
    await prisma.reservation.delete({ where: { id } })

    // 실시간 알림 전송
    req.notificationService.notifyReservationCancelled(
      prev,
      prev.equipment,
      prev.user
    )

    res.status(204).end()
  } catch (error) {
    console.error('Reservation deletion error:', error)
    res.status(500).json({ error: '예약 삭제 실패' })
  }
})

// 실시간 장비 현황 조회 (새로 추가)
router.get('/live/:equipmentId', async (req, res) => {
  try {
    const equipmentId = Number(req.params.equipmentId)
    const today = new Date()
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)

    const reservations = await prisma.reservation.findMany({
      where: {
        equipmentId,
        startAt: {
          gte: today,
          lt: tomorrow
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
      equipmentId,
      date: today.toISOString().split('T')[0],
      reservations,
      lastUpdate: new Date().toISOString()
    })
  } catch (error) {
    console.error('Live equipment status error:', error)
    res.status(500).json({ error: '실시간 현황 조회 실패' })
  }
})
/**
 * 예약 가능 시간 확인
 * GET /api/reservations/availability?equipmentId=1&date=2025-08-29&open=06:00&close=23:00&slotMinutes=30
 */
router.get('/availability', async (req, res) => {
  const equipmentId = Number(req.query.equipmentId)
  const date = req.query.date // YYYY-MM-DD
  const open = req.query.open || '09:00'
  const close = req.query.close || '18:00'
  const slotMinutes = Number(req.query.slotMinutes || 30)
  if (!equipmentId || !date) return res.status(400).json({ error: 'equipmentId, date 필요' })

  // Note: Timezone handling kept simple for demo; adjust in prod as needed.
  const toDate = (d, hm) => new Date(`${d}T${hm}:00.000Z`)
  const openAt = toDate(date, open)
  const closeAt = toDate(date, close)

  const reservations = await prisma.reservation.findMany({
    where: {
      equipmentId,
      startAt: { lt: closeAt },
      endAt:   { gt: openAt }
    },
    orderBy: { startAt: 'asc' }
  })

  const slots = []
  const step = slotMinutes * 60000
  for (let t = +openAt; t + step <= +closeAt; t += step) {
    const s = new Date(t)
    const e = new Date(t + step)
    const overlap = reservations.some(r => r.startAt < e && r.endAt > s)
    if (!overlap) slots.push({ startAt: s.toISOString(), endAt: e.toISOString() })
  }
  res.json({ equipmentId, date, slotMinutes, slots })
})

module.exports = router
