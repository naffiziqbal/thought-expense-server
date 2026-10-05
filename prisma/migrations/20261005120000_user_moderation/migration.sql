-- AlterTable
ALTER TABLE "User" ADD COLUMN "suspendedAt" TIMESTAMP(3),
ADD COLUMN "bannedAt" TIMESTAMP(3),
ADD COLUMN "moderationNote" TEXT;
