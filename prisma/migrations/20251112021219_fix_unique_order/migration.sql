/*
  Warnings:

  - A unique constraint covering the columns `[routineId,order]` on the table `RoutineExercise` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "public"."RoutineExercise_routineId_equipmentId_order_key";

-- CreateIndex
CREATE UNIQUE INDEX "RoutineExercise_routineId_order_key" ON "public"."RoutineExercise"("routineId", "order");
