const { z } = require('zod');

const routineExercise = z.object({
  equipmentId: z.number().int().positive(),
  targetSets: z.number().int().min(1).max(20).default(3),
  targetReps: z.string().optional(),
  restSeconds: z.number().int().min(0).max(900).default(180),
  notes: z.string().optional(),
});

const createRoutineSchema = z.object({
  name: z.string().min(1).max(100),
  exercises: z.array(routineExercise).min(1).max(20),
});

const updateRoutineSchema = createRoutineSchema.partial().extend({
  isActive: z.boolean().optional(),
});

// 🆕 개별 운동 추가/업데이트용 스키마
const addExerciseSchema = z.object({
  equipmentId: z.number().int().positive(),
  targetSets: z.number().int().min(1).max(20).default(3),
  targetReps: z.string().optional(),
  restSeconds: z.number().int().min(0).max(900).default(180), // 초 단위
  notes: z.string().optional(),
});

// 🆕 휴식시간 조정용 스키마
const adjustRestTimeSchema = z.object({
  adjustment: z.number().int().refine(val => [10, -10].includes(val), {
    message: "조정값은 +10 또는 -10 초만 가능합니다"
  })
});

module.exports = { 
  createRoutineSchema, 
  updateRoutineSchema, 
  addExerciseSchema,
  adjustRestTimeSchema
};