-- CreateEnum
CREATE TYPE "Category" AS ENUM ('FOOD', 'TRANSPORT', 'RENT', 'UTILITIES', 'SHOPPING', 'ENTERTAINMENT', 'HEALTHCARE', 'EDUCATION', 'PERSONAL_CARE', 'FEES', 'OTHER');

-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "totalLimit" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoryBudget" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "limit" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CategoryBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoryMapping" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CategoryMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "category" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "rawInput" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Goal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "targetAmount" DOUBLE PRECISION NOT NULL,
    "savedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "deadline" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Insight" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "period" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Insight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isPremium" BOOLEAN NOT NULL DEFAULT false,
    "premiumSince" TIMESTAMP(3),
    "profilePicture" TEXT,
    "premiumUntil" TIMESTAMP(3),
    "subscriptionProductId" TEXT,
    "subscriptionStatus" TEXT,
    "subscriptionStore" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vector" (
    "id" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "vectorId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vector_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Budget_userId_month_year_key" ON "Budget"("userId" ASC, "month" ASC, "year" ASC);

-- CreateIndex
CREATE INDEX "Budget_userId_year_month_idx" ON "Budget"("userId" ASC, "year" ASC, "month" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "CategoryBudget_userId_month_year_category_key" ON "CategoryBudget"("userId" ASC, "month" ASC, "year" ASC, "category" ASC);

-- CreateIndex
CREATE INDEX "CategoryBudget_userId_year_month_category_idx" ON "CategoryBudget"("userId" ASC, "year" ASC, "month" ASC, "category" ASC);

-- CreateIndex
CREATE INDEX "CategoryMapping_userId_idx" ON "CategoryMapping"("userId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "CategoryMapping_userId_keyword_category_key" ON "CategoryMapping"("userId" ASC, "keyword" ASC, "category" ASC);

-- CreateIndex
CREATE INDEX "Expense_date_idx" ON "Expense"("date" ASC);

-- CreateIndex
CREATE INDEX "Expense_userId_category_idx" ON "Expense"("userId" ASC, "category" ASC);

-- CreateIndex
CREATE INDEX "Expense_userId_date_idx" ON "Expense"("userId" ASC, "date" ASC);

-- CreateIndex
CREATE INDEX "Goal_userId_status_idx" ON "Goal"("userId" ASC, "status" ASC);

-- CreateIndex
CREATE INDEX "Insight_userId_period_idx" ON "Insight"("userId" ASC, "period" ASC);

-- CreateIndex
CREATE INDEX "Insight_userId_type_idx" ON "Insight"("userId" ASC, "type" ASC);

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email" ASC);

-- CreateIndex
CREATE INDEX "Vector_expenseId_idx" ON "Vector"("expenseId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Vector_expenseId_key" ON "Vector"("expenseId" ASC);

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryBudget" ADD CONSTRAINT "CategoryBudget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryMapping" ADD CONSTRAINT "CategoryMapping_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Insight" ADD CONSTRAINT "Insight_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vector" ADD CONSTRAINT "Vector_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

