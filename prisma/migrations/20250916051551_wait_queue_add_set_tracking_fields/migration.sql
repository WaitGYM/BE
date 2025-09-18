/*
  Warnings:

  - You are about to drop the column `sets` on the `EquipmentUsage` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "EquipmentUsage" DROP COLUMN "sets",
ADD COLUMN     "currentSet" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "currentSetStartedAt" TIMESTAMP(3),
ADD COLUMN     "restStartedAt" TIMESTAMP(3),
ADD COLUMN     "setStatus" TEXT NOT NULL DEFAULT 'EXERCISING',
ADD COLUMN     "totalSets" INTEGER NOT NULL DEFAULT 1,
ALTER COLUMN "restMinutes" SET DEFAULT 1;
