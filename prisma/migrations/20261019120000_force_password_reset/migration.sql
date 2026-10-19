-- AlterTable
ALTER TABLE "User" ADD COLUMN "passwordResetRequired" BOOLEAN NOT NULL DEFAULT false;

-- Every account that existed before 2026-10-19 (UTC) must set a new password.
-- Bumping tokenVersion revokes all of their existing sessions on web and mobile.
UPDATE "User"
SET "passwordResetRequired" = true,
    "tokenVersion" = "tokenVersion" + 1
WHERE "createdAt" < '2026-10-19 00:00:00';
