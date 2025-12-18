-- DropForeignKey
ALTER TABLE "public"."EquipmentUsage" DROP CONSTRAINT "EquipmentUsage_userId_fkey";

-- AddForeignKey
ALTER TABLE "public"."EquipmentUsage" ADD CONSTRAINT "EquipmentUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
