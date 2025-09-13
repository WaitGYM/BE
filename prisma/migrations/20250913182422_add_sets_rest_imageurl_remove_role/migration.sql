/*
  Warnings:

  - You are about to drop the column `role` on the `User` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Equipment" ADD COLUMN     "imageUrl" TEXT;

-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN     "restMinutes" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "sets" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "role";
