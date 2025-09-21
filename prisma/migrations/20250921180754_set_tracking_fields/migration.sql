-- CreateTable
CREATE TABLE "EquipmentUsage" (
    "id" SERIAL NOT NULL,
    "equipmentId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "estimatedEndAt" TIMESTAMP(3),
    "totalSets" INTEGER NOT NULL DEFAULT 1,
    "restMinutes" INTEGER NOT NULL DEFAULT 3,
    "status" TEXT NOT NULL DEFAULT 'IN_USE',
    "currentSet" INTEGER NOT NULL DEFAULT 1,
    "setStatus" TEXT NOT NULL DEFAULT 'EXERCISING',
    "currentSetStartedAt" TIMESTAMP(3),
    "restStartedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EquipmentUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaitingQueue" (
    "id" SERIAL NOT NULL,
    "equipmentId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "queuePosition" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaitingQueue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EquipmentUsage_equipmentId_status_idx" ON "EquipmentUsage"("equipmentId", "status");

-- CreateIndex
CREATE INDEX "WaitingQueue_equipmentId_queuePosition_idx" ON "WaitingQueue"("equipmentId", "queuePosition");

-- CreateIndex
CREATE INDEX "WaitingQueue_equipmentId_status_idx" ON "WaitingQueue"("equipmentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WaitingQueue_equipmentId_userId_status_key" ON "WaitingQueue"("equipmentId", "userId", "status");

-- AddForeignKey
ALTER TABLE "EquipmentUsage" ADD CONSTRAINT "EquipmentUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentUsage" ADD CONSTRAINT "EquipmentUsage_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitingQueue" ADD CONSTRAINT "WaitingQueue_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitingQueue" ADD CONSTRAINT "WaitingQueue_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
