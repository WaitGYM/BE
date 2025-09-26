// src/routes/favorites.js
const router = require('express').Router();
const { auth } = require('../middleware/auth');
const asyncRoute = require('../utils/asyncRoute');

const prisma = require('../lib/prisma');

// ───────── 유틸 ─────────
function parsePositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ───────── API ─────────
// GET /api/favorites - 내 즐겨찾기 목록
router.get('/', auth(), asyncRoute(async (req, res) => {
  const favorites = await prisma.favorite.findMany({
    where: { userId: req.user.id },
    include: {
      equipment: {
        select: { id: true, name: true, imageUrl: true, category: true, muscleGroup: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json(
    favorites.map((f) => ({
      id: f.id,
      createdAt: f.createdAt,
      equipment: { ...f.equipment, isFavorite: true },
    })),
  );
}));

// GET /api/favorites/check/:equipmentId - 즐겨찾기 상태 확인
router.get('/check/:equipmentId', auth(), asyncRoute(async (req, res) => {
  const equipmentId = parsePositiveInt(req.params.equipmentId);
  if (!equipmentId) return res.status(400).json({ error: '유효한 equipmentId가 필요합니다' });

  const favorite = await prisma.favorite.findUnique({
    where: { userId_equipmentId: { userId: req.user.id, equipmentId } },
  });

  res.json({ isFavorite: !!favorite });
}));

// DELETE /api/favorites/equipment/:equipmentId - 즐겨찾기 제거
router.delete('/equipment/:equipmentId', auth(), asyncRoute(async (req, res) => {
  const equipmentId = parsePositiveInt(req.params.equipmentId);
  if (!equipmentId) return res.status(400).json({ error: '유효한 equipmentId가 필요합니다' });

  const deleted = await prisma.favorite.deleteMany({
    where: { userId: req.user.id, equipmentId },
  });

  if (deleted.count === 0) {
    return res.status(404).json({ error: '즐겨찾기에서 찾을 수 없습니다' });
  }
  res.status(204).end();
}));

// POST /api/favorites/:equipmentId - 즐겨찾기 추가
router.post('/:equipmentId', auth(), asyncRoute(async (req, res) => {
  const equipmentId = parsePositiveInt(req.params.equipmentId);
  if (!equipmentId) return res.status(400).json({ error: '유효한 equipmentId가 필요합니다' });

  // 기구 존재 여부 확인
  const equipment = await prisma.equipment.findUnique({ where: { id: equipmentId } });
  if (!equipment) return res.status(404).json({ error: '기구를 찾을 수 없습니다' });

  // 중복 방지
  const existing = await prisma.favorite.findUnique({
    where: { userId_equipmentId: { userId: req.user.id, equipmentId } },
  });
  if (existing) {
    return res.status(409).json({
      error: '이미 즐겨찾기에 추가된 기구입니다',
      equipmentId,
    });
  }

  const favorite = await prisma.favorite.create({
    data: { userId: req.user.id, equipmentId },
    include: {
      equipment: {
        select: { id: true, name: true, imageUrl: true, category: true, muscleGroup: true },
      },
    },
  });

  res.status(201).json({
    id: favorite.id,
    createdAt: favorite.createdAt,
    equipment: { ...favorite.equipment, isFavorite: true },
  });
}));

module.exports = router;
