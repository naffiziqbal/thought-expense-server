-- Two-factor sign-in for console admins.
ALTER TABLE "Admin" ADD COLUMN "totpSecret" TEXT;
ALTER TABLE "Admin" ADD COLUMN "totpEnabledAt" TIMESTAMP(3);
