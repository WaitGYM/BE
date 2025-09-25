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

module.exports = { createRoutineSchema, updateRoutineSchema };
