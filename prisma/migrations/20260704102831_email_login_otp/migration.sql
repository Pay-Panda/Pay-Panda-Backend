-- AlterTable
ALTER TABLE "User" ADD COLUMN     "loginOtpAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "loginOtpChallengeHash" TEXT,
ADD COLUMN     "loginOtpExpiresAt" TIMESTAMP(3),
ADD COLUMN     "loginOtpHash" TEXT;
