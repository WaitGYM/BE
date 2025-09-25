const { z } = require('zod');

const routineExercise = z.object({
  equipmentId: z.number().int().positive(),
  targetSets: z.number().int().min(1).max(20).default(3),
  targetReps: z.string().optional(),
  restMinutes: z.number().int().min(0).max(15).default(3),
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
