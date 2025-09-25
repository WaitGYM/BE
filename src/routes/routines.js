const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const { auth } = require('../middleware/auth');
const { createRoutineSchema, updateRoutineSchema } = require('../schemas/routine.schema');
const { toSeconds } = require('../utils/time');
const asyncRoute = require('../utils/asyncRoute');

const prisma = new PrismaClient();

// GET /api/routines
router.get('/', auth(), asyncRoute(async (req, res) => {
  const { isActive } = req.query;
  const where = { userId: req.user.id, ...(isActive !== undefined && { isActive: isActive === 'true' }) };

  const routines = await prisma.workoutRoutine.findMany({
    where,
    include: {
      exercises: {
        include: { equipment: { select: { id: true, name: true, category: true, muscleGroup: true, imageUrl: true } } },
        orderBy: { order: 'asc' },
      },
      _count: { select: { exercises: true } },
    },
    orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
  });

  res.json(routines.map((r) => ({
    id: r.id, name: r.name, isActive: r.isActive, exerciseCount: r._count.exercises,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
    exercises: r.exercises.map((ex) => ({ id: ex.id, order: ex.order, targetSets: ex.targetSets, targetReps: ex.targetReps, restMinutes: ex.restMinutes, notes: ex.notes, equipment: ex.equipment })),
  })));
}));

// GET /api/routines/:id
router.get('/:id', auth(), asyncRoute(async (req, res) => {
  const routineId = parseInt(req.params.id, 10);
  const routine = await prisma.workoutRoutine.findFirst({
    where: { id: routineId, userId: req.user.id },
    include: { exercises: { include: { equipment: true }, orderBy: { order: 'asc' } } },
  });
  if (!routine) return res.status(404).json({ error: '루틴을 찾을 수 없습니다' });

  const equipmentIds = routine.exercises.map((e) => e.equipmentId);
  const [currentUsages, waitingQueues, myCurrentUsage, myWaitingQueues] = await Promise.all([
    prisma.equipmentUsage.findMany({ where: { equipmentId: { in: equipmentIds }, status: 'IN_USE' }, include: { user: { select: { name: true } } } }),
    prisma.waitingQueue.findMany({ where: { equipmentId: { in: equipmentIds }, status: { in: ['WAITING', 'NOTIFIED'] } }, orderBy: { queuePosition: 'asc' } }),
    prisma.equipmentUsage.findFirst({ where: { userId: req.user.id, status: 'IN_USE' }, include: { equipment: true } }),
    prisma.waitingQueue.findMany({ where: { userId: req.user.id, status: { in: ['WAITING', 'NOTIFIED'] }, equipmentId: { in: equipmentIds } } }),
  ]);

  const exercises = routine.exercises.map((ex) => {
    const cu = currentUsages.find((u) => u.equipmentId === ex.equipmentId);
    const queueCount = waitingQueues.filter((q) => q.equipmentId === ex.equipmentId).length;
    const myQ = myWaitingQueues.find((q) => q.equipmentId === ex.equipmentId);
    return {
      id: ex.id, order: ex.order, targetSets: ex.targetSets, targetReps: ex.targetReps, restMinutes: ex.restMinutes, notes: ex.notes, equipment: ex.equipment,
      status: {
        isAvailable: !cu,
        currentUser: cu ? cu.user.name : null,
        currentUserStartedAt: cu ? cu.startedAt : null,
        waitingCount: queueCount,
        myQueuePosition: myQ ? myQ.queuePosition : null,
        myQueueStatus: myQ ? myQ.status : null,
        canStart: !cu && !myQ && (!myCurrentUsage || myCurrentUsage.equipmentId === ex.equipmentId),
        canQueue: cu && !myQ && (!myCurrentUsage || myCurrentUsage.equipmentId === ex.equipmentId),
      },
    };
  });

  res.json({ id: routine.id, name: routine.name, isActive: routine.isActive, createdAt: routine.createdAt, updatedAt: routine.updatedAt, exercises, currentlyUsing: myCurrentUsage ? { equipmentId: myCurrentUsage.equipmentId, equipmentName: myCurrentUsage.equipment.name } : null });
}));

// POST /api/routines
router.post('/', auth(), asyncRoute(async (req, res) => {
  const v = createRoutineSchema.safeParse(req.body);
  if (!v.success) return res.status(400).json({ error: '입력 데이터가 올바르지 않습니다', details: v.error.issues });

  const { name, exercises } = v.data;

  const equipmentIds = exercises.map((e) => e.equipmentId);
  const exists = await prisma.equipment.count({ where: { id: { in: equipmentIds } } });
  if (exists !== equipmentIds.length) return res.status(400).json({ error: '존재하지 않는 기구가 포함되어 있습니다' });

  const routine = await prisma.$transaction(async (tx) => {
    const created = await tx.workoutRoutine.create({ data: { userId: req.user.id, name } });
    await tx.routineExercise.createMany({
      data: exercises.map((e, i) => ({
        routineId: created.id, equipmentId: e.equipmentId, order: i + 1, targetSets: e.targetSets, targetReps: e.targetReps, restMinutes: e.restMinutes, notes: e.notes,
      })),
    });
    return tx.workoutRoutine.findUnique({ where: { id: created.id }, include: { exercises: { include: { equipment: true }, orderBy: { order: 'asc' } } } });
  });

  res.status(201).json({ id: routine.id, name: routine.name, isActive: routine.isActive, exerciseCount: routine.exercises.length, exercises: routine.exercises, createdAt: routine.createdAt, updatedAt: routine.updatedAt });
}));

// PUT /api/routines/:id
router.put('/:id', auth(), asyncRoute(async (req, res) => {
  const routineId = parseInt(req.params.id, 10);
  const v = updateRoutineSchema.safeParse(req.body);
  if (!v.success) return res.status(400).json({ error: '입력 데이터가 올바르지 않습니다', details: v.error.issues });

  const { name, isActive, exercises } = v.data;
  const existing = await prisma.workoutRoutine.findFirst({ where: { id: routineId, userId: req.user.id } });
  if (!existing) return res.status(404).json({ error: '루틴을 찾을 수 없습니다' });

  const updated = await prisma.$transaction(async (tx) => {
    await tx.workoutRoutine.update({ where: { id: routineId }, data: { ...(name !== undefined && { name }), ...(isActive !== undefined && { isActive }), updatedAt: new Date() } });

    if (exercises) {
      await tx.routineExercise.deleteMany({ where: { routineId } });
      if (exercises.length) {
        await tx.routineExercise.createMany({
          data: exercises.map((e, i) => ({
            routineId, equipmentId: e.equipmentId, order: i + 1, targetSets: e.targetSets ?? 3, targetReps: e.targetReps, restMinutes: e.restMinutes ?? 3, notes: e.notes,
          })),
        });
      }
    }
    return tx.workoutRoutine.findUnique({ where: { id: routineId }, include: { exercises: { include: { equipment: true }, orderBy: { order: 'asc' } } } });
  });

  res.json(updated);
}));

// DELETE /api/routines/:id
router.delete('/:id', auth(), asyncRoute(async (req, res) => {
  const routineId = parseInt(req.params.id, 10);
  const routine = await prisma.workoutRoutine.findFirst({ where: { id: routineId, userId: req.user.id } });
  if (!routine) return res.status(404).json({ error: '루틴을 찾을 수 없습니다' });
  await prisma.workoutRoutine.delete({ where: { id: routineId } });
  res.status(204).end();
}));

// POST /api/routines/:routineId/exercises/:exerciseId/start
router.post('/:routineId/exercises/:exerciseId/start', auth(), asyncRoute(async (req, res) => {
  const { routineId, exerciseId } = req.params;
  const { totalSets, restMinutes } = req.body;

  const exercise = await prisma.routineExercise.findFirst({
    where: { id: parseInt(exerciseId, 10), routineId: parseInt(routineId, 10), routine: { userId: req.user.id } },
    include: { equipment: true, routine: true },
  });
  if (!exercise) return res.status(404).json({ error: '운동 항목을 찾을 수 없습니다' });

  const equipmentId = exercise.equipmentId;
  const sets = totalSets || exercise.targetSets;
  const restSec = toSeconds(restMinutes ?? exercise.restMinutes); // ← 입력은 분, 저장/계산은 초

  const currentUsage = await prisma.equipmentUsage.findFirst({ where: { equipmentId, status: 'IN_USE' } });
  if (currentUsage && currentUsage.userId !== req.user.id) return res.status(409).json({ error: '기구가 사용 중입니다', message: '대기열에 등록하거나 나중에 다시 시도해주세요' });

  const myUsage = await prisma.equipmentUsage.findFirst({ where: { userId: req.user.id, status: 'IN_USE' } });
  if (myUsage && myUsage.equipmentId !== equipmentId) return res.status(409).json({ error: '이미 다른 기구를 사용 중입니다', currentEquipmentId: myUsage.equipmentId });

  const usage = await prisma.equipmentUsage.create({
    data: {
      equipmentId, userId: req.user.id, totalSets: sets,
      restSeconds: restSec, status: 'IN_USE', setStatus: 'EXERCISING',
      currentSet: 1, currentSetStartedAt: new Date(),
      estimatedEndAt: new Date(Date.now() + ((sets * 5) + ((sets - 1) * (restSec / 60))) * 60 * 1000),
    },
  });

  res.json({ message: `${exercise.equipment.name} 사용을 시작했습니다`, equipmentName: exercise.equipment.name, totalSets: sets, restMinutes: Math.round(restSec / 60), usageId: usage.id });
}));

// POST /api/routines/:routineId/exercises/:exerciseId/queue
router.post('/:routineId/exercises/:exerciseId/queue', auth(), asyncRoute(async (req, res) => {
  const { routineId, exerciseId } = req.params;

  const exercise = await prisma.routineExercise.findFirst({
    where: { id: parseInt(exerciseId, 10), routineId: parseInt(routineId, 10), routine: { userId: req.user.id } },
    include: { equipment: true },
  });
  if (!exercise) return res.status(404).json({ error: '운동 항목을 찾을 수 없습니다' });

  const equipmentId = exercise.equipmentId;
  const existingQueue = await prisma.waitingQueue.findFirst({ where: { equipmentId, userId: req.user.id, status: { in: ['WAITING', 'NOTIFIED'] } } });
  if (existingQueue) return res.status(409).json({ error: '이미 대기열에 등록되어 있습니다', queuePosition: existingQueue.queuePosition });

  const length = await prisma.waitingQueue.count({ where: { equipmentId, status: { in: ['WAITING', 'NOTIFIED'] } } });
  const queue = await prisma.waitingQueue.create({ data: { equipmentId, userId: req.user.id, queuePosition: length + 1, status: 'WAITING' } });

  res.json({ message: `${exercise.equipment.name} 대기열에 등록되었습니다`, equipmentName: exercise.equipment.name, queuePosition: queue.queuePosition, queueId: queue.id });
}));

module.exports = router;
