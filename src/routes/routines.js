// src/routes/routines.js
const router = require('express').Router()
const { PrismaClient } = require('@prisma/client')
const { auth } = require('../middleware/auth')
const { z } = require('zod')
const jwt = require('jsonwebtoken')

const prisma = new PrismaClient()

// 입력 검증 스키마
const createRoutineSchema = z.object({
  name: z.string().min(1).max(100),
  exercises: z.array(z.object({
    equipmentId: z.number().int().positive(),
    targetSets: z.number().int().min(1).max(20).default(3),
    targetReps: z.string().optional(),
    restMinutes: z.number().int().min(0).max(15).default(3),
    notes: z.string().optional()
  })).min(1).max(20)
})

const updateRoutineSchema = createRoutineSchema.partial().extend({
  isActive: z.boolean().optional()
})

// ==================== 루틴 CRUD ====================

// 내 루틴 목록 조회
router.get('/', auth(), async (req, res) => {
  try {
    const { isActive } = req.query
    
    const where = { 
      userId: req.user.id,
      ...(isActive !== undefined && { isActive: isActive === 'true' })
    }

    const routines = await prisma.workoutRoutine.findMany({
      where,
      include: {
        exercises: {
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
          orderBy: { order: 'asc' }
        },
        _count: {
          select: { exercises: true }
        }
      },
      orderBy: [
        { isActive: 'desc' },
        { updatedAt: 'desc' }
      ]
    })

    const response = routines.map(routine => ({
      id: routine.id,
      name: routine.name,
      isActive: routine.isActive,
      exerciseCount: routine._count.exercises,
      createdAt: routine.createdAt,
      updatedAt: routine.updatedAt,
      exercises: routine.exercises.map(ex => ({
        id: ex.id,
        order: ex.order,
        targetSets: ex.targetSets,
        targetReps: ex.targetReps,
        restMinutes: ex.restMinutes,
        notes: ex.notes,
        equipment: ex.equipment
      }))
    }))

    res.json(response)
  } catch (error) {
    console.error('루틴 목록 조회 오류:', error)
    res.status(500).json({ error: '루틴 목록을 불러올 수 없습니다' })
  }
})

// 특정 루틴 상세 조회 (기구 상태 포함)
router.get('/:id', auth(), async (req, res) => {
  try {
    const routineId = parseInt(req.params.id)
    
    const routine = await prisma.workoutRoutine.findFirst({
      where: { id: routineId, userId: req.user.id },
      include: {
        exercises: {
          include: {
            equipment: true
          },
          orderBy: { order: 'asc' }
        }
      }
    })

    if (!routine) {
      return res.status(404).json({ error: '루틴을 찾을 수 없습니다' })
    }

    // 각 기구의 현재 상태 조회
    const equipmentIds = routine.exercises.map(ex => ex.equipmentId)
    
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

    // 내가 현재 사용 중인 기구
    const myCurrentUsage = await prisma.equipmentUsage.findFirst({
      where: { userId: req.user.id, status: 'IN_USE' },
      include: { equipment: true }
    })

    // 내가 대기 중인 기구들
    const myWaitingQueues = await prisma.waitingQueue.findMany({
      where: { 
        userId: req.user.id, 
        status: { in: ['WAITING', 'NOTIFIED'] },
        equipmentId: { in: equipmentIds }
      }
    })

    // 응답 데이터 구성
    const exercisesWithStatus = routine.exercises.map(exercise => {
      const currentUsage = currentUsages.find(u => u.equipmentId === exercise.equipmentId)
      const queueCount = waitingQueues.filter(q => q.equipmentId === exercise.equipmentId).length
      const myQueue = myWaitingQueues.find(q => q.equipmentId === exercise.equipmentId)
      
      return {
        id: exercise.id,
        order: exercise.order,
        targetSets: exercise.targetSets,
        targetReps: exercise.targetReps,
        restMinutes: exercise.restMinutes,
        notes: exercise.notes,
        equipment: exercise.equipment,
        // 기구 상태 정보
        status: {
          isAvailable: !currentUsage,
          currentUser: currentUsage ? currentUsage.user.name : null,
          currentUserStartedAt: currentUsage ? currentUsage.startedAt : null,
          waitingCount: queueCount,
          myQueuePosition: myQueue ? myQueue.queuePosition : null,
          myQueueStatus: myQueue ? myQueue.status : null,
          canStart: !currentUsage && !myQueue && (!myCurrentUsage || myCurrentUsage.equipmentId === exercise.equipmentId),
          canQueue: currentUsage && !myQueue && (!myCurrentUsage || myCurrentUsage.equipmentId === exercise.equipmentId)
        }
      }
    })

    res.json({
      id: routine.id,
      name: routine.name,
      isActive: routine.isActive,
      createdAt: routine.createdAt,
      updatedAt: routine.updatedAt,
      exercises: exercisesWithStatus,
      currentlyUsing: myCurrentUsage ? {
        equipmentId: myCurrentUsage.equipmentId,
        equipmentName: myCurrentUsage.equipment.name
      } : null
    })
  } catch (error) {
    console.error('루틴 상세 조회 오류:', error)
    res.status(500).json({ error: '루틴 정보를 불러올 수 없습니다' })
  }
})

// 루틴 생성
router.post('/', auth(), async (req, res) => {
  try {
    const validation = createRoutineSchema.safeParse(req.body)
    if (!validation.success) {
      return res.status(400).json({ 
        error: '입력 데이터가 올바르지 않습니다', 
        details: validation.error.issues 
      })
    }

    const { name, exercises } = validation.data

    // 기구 존재 확인
    const equipmentIds = exercises.map(ex => ex.equipmentId)
    const existingEquipment = await prisma.equipment.findMany({
      where: { id: { in: equipmentIds } }
    })

    if (existingEquipment.length !== equipmentIds.length) {
      return res.status(400).json({ error: '존재하지 않는 기구가 포함되어 있습니다' })
    }

    const routine = await prisma.$transaction(async (tx) => {
      // 루틴 생성
      const newRoutine = await tx.workoutRoutine.create({
        data: {
          userId: req.user.id,
          name
        }
      })

      // 운동 항목들 생성
      const exerciseData = exercises.map((exercise, index) => ({
        routineId: newRoutine.id,
        equipmentId: exercise.equipmentId,
        order: index + 1,
        targetSets: exercise.targetSets,
        targetReps: exercise.targetReps,
        restMinutes: exercise.restMinutes,
        notes: exercise.notes
      }))

      await tx.routineExercise.createMany({
        data: exerciseData
      })

      // 생성된 루틴 반환
      return await tx.workoutRoutine.findUnique({
        where: { id: newRoutine.id },
        include: {
          exercises: {
            include: {
              equipment: true
            },
            orderBy: { order: 'asc' }
          }
        }
      })
    })

    res.status(201).json({
      id: routine.id,
      name: routine.name,
      isActive: routine.isActive,
      exerciseCount: routine.exercises.length,
      exercises: routine.exercises,
      createdAt: routine.createdAt,
      updatedAt: routine.updatedAt
    })
  } catch (error) {
    console.error('루틴 생성 오류:', error)
    res.status(500).json({ error: '루틴 생성에 실패했습니다' })
  }
})

// 루틴 수정
router.put('/:id', auth(), async (req, res) => {
  try {
    const routineId = parseInt(req.params.id)
    
    const validation = updateRoutineSchema.safeParse(req.body)
    if (!validation.success) {
      return res.status(400).json({ 
        error: '입력 데이터가 올바르지 않습니다', 
        details: validation.error.issues 
      })
    }

    const { name, isActive, exercises } = validation.data

    // 루틴 소유권 확인
    const existingRoutine = await prisma.workoutRoutine.findFirst({
      where: { id: routineId, userId: req.user.id }
    })

    if (!existingRoutine) {
      return res.status(404).json({ error: '루틴을 찾을 수 없습니다' })
    }

    const updatedRoutine = await prisma.$transaction(async (tx) => {
      // 루틴 기본 정보 업데이트
      const routine = await tx.workoutRoutine.update({
        where: { id: routineId },
        data: {
          ...(name !== undefined && { name }),
          ...(isActive !== undefined && { isActive }),
          updatedAt: new Date()
        }
      })

      // 운동 항목들 업데이트 (전체 교체 방식)
      if (exercises) {
        // 기존 운동 항목들 삭제
        await tx.routineExercise.deleteMany({
          where: { routineId }
        })

        // 새 운동 항목들 추가
        if (exercises.length > 0) {
          const exerciseData = exercises.map((exercise, index) => ({
            routineId,
            equipmentId: exercise.equipmentId,
            order: index + 1,
            targetSets: exercise.targetSets || 3,
            targetReps: exercise.targetReps,
            restMinutes: exercise.restMinutes || 3,
            notes: exercise.notes
          }))

          await tx.routineExercise.createMany({
            data: exerciseData
          })
        }
      }

      // 업데이트된 루틴 반환
      return await tx.workoutRoutine.findUnique({
        where: { id: routineId },
        include: {
          exercises: {
            include: {
              equipment: true
            },
            orderBy: { order: 'asc' }
          }
        }
      })
    })

    res.json(updatedRoutine)
  } catch (error) {
    console.error('루틴 수정 오류:', error)
    res.status(500).json({ error: '루틴 수정에 실패했습니다' })
  }
})

// 루틴 삭제
router.delete('/:id', auth(), async (req, res) => {
  try {
    const routineId = parseInt(req.params.id)

    // 루틴 소유권 확인
    const routine = await prisma.workoutRoutine.findFirst({
      where: { id: routineId, userId: req.user.id }
    })

    if (!routine) {
      return res.status(404).json({ error: '루틴을 찾을 수 없습니다' })
    }

    await prisma.workoutRoutine.delete({
      where: { id: routineId }
    })

    res.status(204).end()
  } catch (error) {
    console.error('루틴 삭제 오류:', error)
    res.status(500).json({ error: '루틴 삭제에 실패했습니다' })
  }
})

// ==================== 루틴 내 기구 액션 ====================

// 루틴 내 기구 사용 시작
router.post('/:routineId/exercises/:exerciseId/start', auth(), async (req, res) => {
  try {
    const { routineId, exerciseId } = req.params
    const { totalSets, restMinutes } = req.body

    // 루틴과 운동 항목 확인
    const exercise = await prisma.routineExercise.findFirst({
      where: { 
        id: parseInt(exerciseId),
        routineId: parseInt(routineId),
        routine: { userId: req.user.id }
      },
      include: {
        equipment: true,
        routine: true
      }
    })

    if (!exercise) {
      return res.status(404).json({ error: '운동 항목을 찾을 수 없습니다' })
    }

    // 기구 사용 시작 (기존 waiting.js의 로직 활용)
    const equipmentId = exercise.equipmentId
    const sets = totalSets || exercise.targetSets
    const rest = restMinutes || exercise.restMinutes

    // 현재 사용 중인지 확인
    const currentUsage = await prisma.equipmentUsage.findFirst({
      where: { equipmentId, status: 'IN_USE' }
    })

    if (currentUsage && currentUsage.userId !== req.user.id) {
      return res.status(409).json({ 
        error: '기구가 사용 중입니다',
        message: '대기열에 등록하거나 나중에 다시 시도해주세요'
      })
    }

    // 내가 이미 다른 기구 사용 중인지 확인
    const myUsage = await prisma.equipmentUsage.findFirst({
      where: { userId: req.user.id, status: 'IN_USE' }
    })

    if (myUsage && myUsage.equipmentId !== equipmentId) {
      return res.status(409).json({ 
        error: '이미 다른 기구를 사용 중입니다',
        currentEquipmentId: myUsage.equipmentId
      })
    }

    // 기구 사용 시작
    const usage = await prisma.equipmentUsage.create({
      data: {
        equipmentId,
        userId: req.user.id,
        totalSets: sets,
        restMinutes: rest,
        status: 'IN_USE',
        setStatus: 'EXERCISING',
        currentSet: 1,
        currentSetStartedAt: new Date(),
        estimatedEndAt: new Date(Date.now() + ((sets * 5) + ((sets - 1) * rest)) * 60 * 1000)
      }
    })

    res.json({
      message: `${exercise.equipment.name} 사용을 시작했습니다`,
      equipmentName: exercise.equipment.name,
      totalSets: sets,
      restMinutes: rest,
      usageId: usage.id
    })
  } catch (error) {
    console.error('루틴 내 기구 사용 시작 오류:', error)
    res.status(500).json({ error: '기구 사용 시작에 실패했습니다' })
  }
})

// 루틴 내 기구 대기열 등록
router.post('/:routineId/exercises/:exerciseId/queue', auth(), async (req, res) => {
  try {
    const { routineId, exerciseId } = req.params

    // 루틴과 운동 항목 확인
    const exercise = await prisma.routineExercise.findFirst({
      where: { 
        id: parseInt(exerciseId),
        routineId: parseInt(routineId),
        routine: { userId: req.user.id }
      },
      include: {
        equipment: true
      }
    })

    if (!exercise) {
      return res.status(404).json({ error: '운동 항목을 찾을 수 없습니다' })
    }

    const equipmentId = exercise.equipmentId

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
        queuePosition: existingQueue.queuePosition 
      })
    }

    // 대기열에 추가
    const queueLength = await prisma.waitingQueue.count({
      where: { equipmentId, status: { in: ['WAITING', 'NOTIFIED'] } }
    })

    const queue = await prisma.waitingQueue.create({
      data: {
        equipmentId,
        userId: req.user.id,
        queuePosition: queueLength + 1,
        status: 'WAITING'
      }
    })

    res.json({
      message: `${exercise.equipment.name} 대기열에 등록되었습니다`,
      equipmentName: exercise.equipment.name,
      queuePosition: queue.queuePosition,
      queueId: queue.id
    })
  } catch (error) {
    console.error('루틴 내 기구 대기 등록 오류:', error)
    res.status(500).json({ error: '대기열 등록에 실패했습니다' })
  }
})

module.exports = router
