-- CreateEnum
CREATE TYPE "UnresolvedPaymentStatus" AS ENUM ('pending', 'resolved', 'dismissed');

-- CreateTable
CREATE TABLE "UnresolvedStripePayment" (
    "id" TEXT NOT NULL,
    "stripeChargeId" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "customerEmail" TEXT,
    "customerName" TEXT,
    "description" TEXT,
    "productHandles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "UnresolvedPaymentStatus" NOT NULL DEFAULT 'pending',
    "resolvedFamilyId" TEXT,
    "resolvedPaymentId" TEXT,
    "dismissReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "UnresolvedStripePayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UnresolvedStripePayment_stripeChargeId_key" ON "UnresolvedStripePayment"("stripeChargeId");

-- CreateIndex
CREATE INDEX "UnresolvedStripePayment_status_idx" ON "UnresolvedStripePayment"("status");

-- CreateIndex
CREATE INDEX "UnresolvedStripePayment_stripeCustomerId_idx" ON "UnresolvedStripePayment"("stripeCustomerId");

