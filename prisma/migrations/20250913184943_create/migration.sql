/*
  Warnings:

  - You are about to drop the column `location` on the `Equipment` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[name]` on the table `Equipment` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Equipment" DROP COLUMN "location";

-- CreateIndex
CREATE UNIQUE INDEX "Equipment_name_key" ON "Equipment"("name");
