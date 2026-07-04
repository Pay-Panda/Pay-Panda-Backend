-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('PENDING', 'ACTIVE', 'ERROR', 'DISABLED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PaymentSource" AS ENUM ('API', 'DASHBOARD', 'DEFAULT_LINK');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "mobile" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'OWNER',
    "businessId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Business" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "supportEmail" TEXT,
    "logoPath" TEXT,
    "paymentExpiryMins" INTEGER NOT NULL DEFAULT 10,
    "payerNameMatching" BOOLEAN NOT NULL DEFAULT false,
    "webhookUrl" TEXT,
    "webhookSecret" TEXT,
    "theme" TEXT NOT NULL DEFAULT 'midnight',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Business_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiClient" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantConnection" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'BHARATPE',
    "label" TEXT,
    "mobile" TEXT NOT NULL,
    "encryptedToken" TEXT NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "merchantId" TEXT,
    "merchantMid" TEXT,
    "merchantName" TEXT,
    "legalBusinessName" TEXT,
    "category" TEXT,
    "subCategory" TEXT,
    "kycType" TEXT,
    "merchantType" TEXT,
    "merchantPaymentType" TEXT,
    "beneficiaryName" TEXT,
    "bankName" TEXT,
    "maskedAccountNumber" TEXT,
    "ifsc" TEXT,
    "upiId" TEXT,
    "baseUpiIntent" TEXT,
    "providerQrUrl" TEXT,
    "qrImage" BYTEA,
    "rawMerchantData" JSONB,
    "lastConnectedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "clientOrderId" TEXT NOT NULL,
    "customerName" TEXT,
    "customerMobile" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "reason" TEXT,
    "remark1" TEXT,
    "remark2" TEXT,
    "redirectUrl" TEXT,
    "source" "PaymentSource" NOT NULL DEFAULT 'API',
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "upiIntent" TEXT NOT NULL,
    "qrImage" BYTEA NOT NULL,
    "providerTransactionId" TEXT,
    "bankReferenceNo" TEXT,
    "internalUtr" TEXT,
    "payerName" TEXT,
    "payerHandle" TEXT,
    "paidAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderTransaction" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerTransactionId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "paymentTimestamp" TIMESTAMP(3) NOT NULL,
    "internalUtr" TEXT,
    "bankReferenceNo" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "payerName" TEXT,
    "payerHandle" TEXT,
    "type" TEXT,
    "status" TEXT NOT NULL,
    "payeeIdentifier" TEXT,
    "rawData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiRequestLog" (
    "id" TEXT NOT NULL,
    "businessId" TEXT,
    "appId" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "requestId" TEXT NOT NULL,
    "ipAddress" TEXT,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiRequestLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ApiClient_appId_key" ON "ApiClient"("appId");

-- CreateIndex
CREATE INDEX "MerchantConnection_businessId_status_idx" ON "MerchantConnection"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantConnection_provider_merchantId_key" ON "MerchantConnection"("provider", "merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_publicId_key" ON "Payment"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_providerTransactionId_key" ON "Payment"("providerTransactionId");

-- CreateIndex
CREATE INDEX "Payment_businessId_status_createdAt_idx" ON "Payment"("businessId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_connectionId_status_expiresAt_idx" ON "Payment"("connectionId", "status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_businessId_clientOrderId_key" ON "Payment"("businessId", "clientOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderTransaction_providerTransactionId_key" ON "ProviderTransaction"("providerTransactionId");

-- CreateIndex
CREATE INDEX "ProviderTransaction_businessId_paymentTimestamp_idx" ON "ProviderTransaction"("businessId", "paymentTimestamp");

-- CreateIndex
CREATE INDEX "ProviderTransaction_merchantId_amount_paymentTimestamp_idx" ON "ProviderTransaction"("merchantId", "amount", "paymentTimestamp");

-- CreateIndex
CREATE INDEX "ApiRequestLog_businessId_createdAt_idx" ON "ApiRequestLog"("businessId", "createdAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiClient" ADD CONSTRAINT "ApiClient_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantConnection" ADD CONSTRAINT "MerchantConnection_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "MerchantConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderTransaction" ADD CONSTRAINT "ProviderTransaction_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
