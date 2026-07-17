-- Add sub-business / business-unit tracking. Settlement still happens through the
-- parent Business connection; this table is for reporting and payment grouping.
CREATE TABLE "BusinessUnit" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessUnit_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "BusinessUnit"
  ADD CONSTRAINT "BusinessUnit_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "BusinessUnit_businessId_code_key" ON "BusinessUnit"("businessId", "code");
CREATE INDEX "BusinessUnit_businessId_active_idx" ON "BusinessUnit"("businessId", "active");

ALTER TABLE "Payment" ADD COLUMN "businessUnitId" TEXT;

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_businessUnitId_fkey"
  FOREIGN KEY ("businessUnitId") REFERENCES "BusinessUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Payment_businessUnitId_status_createdAt_idx" ON "Payment"("businessUnitId", "status", "createdAt");
