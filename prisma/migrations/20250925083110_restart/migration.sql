/*
  Warnings:

  - You are about to drop the column `restMinutes` on the `EquipmentUsage` table. All the data in the column will be lost.
  - You are about to drop the column `restMinutes` on the `Reservation` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "EquipmentUsage" DROP COLUMN "restMinutes",
ADD COLUMN     "restSeconds" INTEGER NOT NULL DEFAULT 180;

-- AlterTable
ALTER TABLE "Reservation" DROP COLUMN "restMinutes",
ADD COLUMN     "restSeconds" INTEGER NOT NULL DEFAULT 180;
