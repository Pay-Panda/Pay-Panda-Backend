-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('PENDING', 'PAID', 'EXPIRED');

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "checkoutLayout" TEXT NOT NULL DEFAULT 'both',
ADD COLUMN     "isPlatform" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "platformFeeAmount" DECIMAL(6,2);

-- CreateTable
CREATE TABLE "SubscriptionInvoice" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "paymentCount" INTEGER NOT NULL,
    "totalFeeAmount" DECIMAL(10,2) NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "paymentId" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DefaultLink" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT,
    "minAmount" DECIMAL(10,2),
    "maxAmount" DECIMAL(10,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DefaultLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionInvoice_paymentId_key" ON "SubscriptionInvoice"("paymentId");

-- CreateIndex
CREATE INDEX "SubscriptionInvoice_businessId_status_idx" ON "SubscriptionInvoice"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionInvoice_businessId_periodStart_key" ON "SubscriptionInvoice"("businessId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "DefaultLink_businessId_key" ON "DefaultLink"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "DefaultLink_slug_key" ON "DefaultLink"("slug");

-- AddForeignKey
ALTER TABLE "SubscriptionInvoice" ADD CONSTRAINT "SubscriptionInvoice_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DefaultLink" ADD CONSTRAINT "DefaultLink_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

