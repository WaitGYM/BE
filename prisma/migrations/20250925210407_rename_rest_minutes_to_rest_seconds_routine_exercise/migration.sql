/*
  Warnings:

  - You are about to drop the column `restMinutes` on the `RoutineExercise` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."RoutineExercise" DROP COLUMN "restMinutes",
ADD COLUMN     "restSeconds" INTEGER NOT NULL DEFAULT 180;
