-- AlterTable
ALTER TABLE "BillingWebhookEvent" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "countryCode" TEXT,
ADD COLUMN     "currency" TEXT,
ADD COLUMN     "environment" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "payload" JSONB,
ADD COLUMN     "periodType" TEXT,
ADD COLUMN     "priceLocal" DOUBLE PRECISION,
ADD COLUMN     "priceUsd" DOUBLE PRECISION,
ADD COLUMN     "purchasedAt" TIMESTAMP(3),
ADD COLUMN     "transactionId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastActiveAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DeletedAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "signupAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "currency" TEXT,
    "wasPremium" BOOLEAN NOT NULL,
    "subscriptionStatus" TEXT,
    "subscriptionProductId" TEXT,
    "subscriptionStore" TEXT,
    "premiumSince" TIMESTAMP(3),
    "lastActiveAt" TIMESTAMP(3),
    "lastExpenseAt" TIMESTAMP(3),
    "expenseCount" INTEGER NOT NULL,
    "aiCalls" INTEGER NOT NULL DEFAULT 0,
    "aiCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "DeletedAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeletedAccount_deletedAt_idx" ON "DeletedAccount"("deletedAt");

-- CreateIndex
CREATE INDEX "DeletedAccount_signupAt_idx" ON "DeletedAccount"("signupAt");

