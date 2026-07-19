-- AlterTable
ALTER TABLE "ApiClient" ADD COLUMN     "businessUnitId" TEXT;

-- CreateIndex
CREATE INDEX "ApiClient_businessUnitId_idx" ON "ApiClient"("businessUnitId");

-- AddForeignKey
ALTER TABLE "ApiClient" ADD CONSTRAINT "ApiClient_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "BusinessUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

