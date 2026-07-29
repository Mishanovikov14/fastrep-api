-- ExtendEnum
ALTER TYPE "StorageCleanupReason" ADD VALUE 'OUTPUT_REPLACED';
ALTER TYPE "StorageCleanupReason" ADD VALUE 'ORPHAN_OUTPUT';

-- CreateEnum
CREATE TYPE "ReportGenerationStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "ReportGenerationStage" AS ENUM ('PREPARING', 'TRANSCRIBING', 'ANALYZING', 'GENERATING_CONTENT', 'GENERATING_PDF', 'UPLOADING_OUTPUT', 'COMPLETED');
CREATE TYPE "ReportOutputType" AS ENUM ('PDF');
CREATE TYPE "AssetTranscriptionStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'GRACE_PERIOD', 'PAST_DUE', 'CANCELLED', 'EXPIRED');
CREATE TYPE "SubscriptionProvider" AS ENUM ('MANUAL', 'APPLE', 'GOOGLE', 'WEB');
CREATE TYPE "GenerationCreditSource" AS ENUM ('SUBSCRIPTION_MONTHLY', 'PURCHASED_PACK', 'PROMOTIONAL', 'ADMIN', 'REFUND');
CREATE TYPE "GenerationCreditTransactionType" AS ENUM ('GRANT', 'RESERVE', 'CONSUME', 'RELEASE', 'REFUND', 'EXPIRE');
CREATE TYPE "GenerationProviderOperation" AS ENUM ('MODERATION', 'TRANSCRIPTION', 'REPORT_GENERATION');
CREATE TYPE "GenerationProviderAttemptStatus" AS ENUM ('STARTED', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "ReportGeneration" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "ReportGenerationStatus" NOT NULL DEFAULT 'QUEUED',
    "stage" "ReportGenerationStage" NOT NULL DEFAULT 'PREPARING',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "providerRequestId" TEXT,
    "promptVersion" TEXT NOT NULL,
    "inputSnapshot" JSONB,
    "structuredResult" JSONB,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "processingToken" TEXT,
    "processingLeaseExpiresAt" TIMESTAMP(3),
    "enqueuedAt" TIMESTAMP(3),
    "priorReportStatus" "ReportStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportGeneration_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReportOutput" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "type" "ReportOutputType" NOT NULL DEFAULT 'PDF',
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportOutput_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReportAssetTranscription" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "status" "AssetTranscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "text" TEXT,
    "language" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "providerRequestId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportAssetTranscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planCode" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "provider" "SubscriptionProvider" NOT NULL,
    "providerCustomerId" TEXT,
    "providerSubscriptionId" TEXT,
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSubscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GenerationCreditGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" "GenerationCreditSource" NOT NULL,
    "totalCredits" INTEGER NOT NULL,
    "remainingCredits" INTEGER NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "subscriptionPeriodKey" TEXT,
    "externalPurchaseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GenerationCreditGrant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GenerationCreditGrant_totalCredits_check" CHECK ("totalCredits" > 0),
    CONSTRAINT "GenerationCreditGrant_remainingCredits_check" CHECK ("remainingCredits" >= 0 AND "remainingCredits" <= "totalCredits")
);

CREATE TABLE "GenerationCreditTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "generationId" TEXT,
    "grantId" TEXT,
    "type" "GenerationCreditTransactionType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GenerationCreditTransaction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GenerationCreditTransaction_amount_check" CHECK ("amount" > 0)
);

CREATE TABLE "GenerationProviderAttempt" (
    "id" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "assetId" TEXT,
    "operation" "GenerationProviderOperation" NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" "GenerationProviderAttemptStatus" NOT NULL DEFAULT 'STARTED',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "providerRequestId" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "audioDurationSeconds" DOUBLE PRECISION,
    "errorCode" TEXT,
    "processingToken" TEXT NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GenerationProviderAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReportGeneration_userId_reportId_idempotencyKey_key" ON "ReportGeneration"("userId", "reportId", "idempotencyKey");
CREATE INDEX "ReportGeneration_reportId_createdAt_idx" ON "ReportGeneration"("reportId", "createdAt" DESC);
CREATE INDEX "ReportGeneration_userId_createdAt_idx" ON "ReportGeneration"("userId", "createdAt" DESC);
CREATE INDEX "ReportGeneration_status_createdAt_idx" ON "ReportGeneration"("status", "createdAt");
CREATE UNIQUE INDEX "ReportGeneration_one_active_per_report_key" ON "ReportGeneration"("reportId") WHERE "status" IN ('QUEUED', 'PROCESSING');
CREATE UNIQUE INDEX "ReportGeneration_one_active_per_user_key" ON "ReportGeneration"("userId") WHERE "status" IN ('QUEUED', 'PROCESSING');

CREATE UNIQUE INDEX "ReportOutput_reportId_key" ON "ReportOutput"("reportId");
CREATE UNIQUE INDEX "ReportOutput_generationId_key" ON "ReportOutput"("generationId");
CREATE UNIQUE INDEX "ReportOutput_storageKey_key" ON "ReportOutput"("storageKey");
CREATE UNIQUE INDEX "ReportAssetTranscription_assetId_key" ON "ReportAssetTranscription"("assetId");
CREATE INDEX "UserSubscription_userId_status_currentPeriodEnd_idx" ON "UserSubscription"("userId", "status", "currentPeriodEnd");
CREATE UNIQUE INDEX "UserSubscription_provider_providerSubscriptionId_key" ON "UserSubscription"("provider", "providerSubscriptionId");
CREATE UNIQUE INDEX "GenerationCreditGrant_userId_subscriptionPeriodKey_key" ON "GenerationCreditGrant"("userId", "subscriptionPeriodKey");
CREATE UNIQUE INDEX "GenerationCreditGrant_source_externalPurchaseId_key" ON "GenerationCreditGrant"("source", "externalPurchaseId");
CREATE INDEX "GenerationCreditGrant_userId_validFrom_expiresAt_idx" ON "GenerationCreditGrant"("userId", "validFrom", "expiresAt");
CREATE UNIQUE INDEX "GenerationCreditTransaction_idempotencyKey_key" ON "GenerationCreditTransaction"("idempotencyKey");
CREATE UNIQUE INDEX "GenerationCreditTransaction_one_reserve_per_generation_key" ON "GenerationCreditTransaction"("generationId") WHERE "type" = 'RESERVE';
CREATE UNIQUE INDEX "GenerationCreditTransaction_one_terminal_per_generation_key" ON "GenerationCreditTransaction"("generationId") WHERE "type" IN ('CONSUME', 'RELEASE', 'REFUND');
CREATE INDEX "GenerationCreditTransaction_userId_createdAt_idx" ON "GenerationCreditTransaction"("userId", "createdAt");
CREATE INDEX "GenerationCreditTransaction_generationId_idx" ON "GenerationCreditTransaction"("generationId");
CREATE INDEX "GenerationCreditTransaction_grantId_idx" ON "GenerationCreditTransaction"("grantId");
CREATE UNIQUE INDEX "GenerationProviderAttempt_generationId_operation_assetId_attemptNumber_key" ON "GenerationProviderAttempt"("generationId", "operation", "assetId", "attemptNumber");
CREATE UNIQUE INDEX "GenerationProviderAttempt_report_attempt_key" ON "GenerationProviderAttempt"("generationId", "operation", "attemptNumber") WHERE "assetId" IS NULL;
CREATE INDEX "GenerationProviderAttempt_generationId_operation_idx" ON "GenerationProviderAttempt"("generationId", "operation");
CREATE INDEX "GenerationProviderAttempt_assetId_operation_idx" ON "GenerationProviderAttempt"("assetId", "operation");

-- AddForeignKey
ALTER TABLE "ReportGeneration" ADD CONSTRAINT "ReportGeneration_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReportGeneration" ADD CONSTRAINT "ReportGeneration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReportOutput" ADD CONSTRAINT "ReportOutput_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReportOutput" ADD CONSTRAINT "ReportOutput_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "ReportGeneration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReportAssetTranscription" ADD CONSTRAINT "ReportAssetTranscription_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "ReportAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserSubscription" ADD CONSTRAINT "UserSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GenerationCreditGrant" ADD CONSTRAINT "GenerationCreditGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GenerationCreditTransaction" ADD CONSTRAINT "GenerationCreditTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GenerationCreditTransaction" ADD CONSTRAINT "GenerationCreditTransaction_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "ReportGeneration"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GenerationCreditTransaction" ADD CONSTRAINT "GenerationCreditTransaction_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "GenerationCreditGrant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GenerationProviderAttempt" ADD CONSTRAINT "GenerationProviderAttempt_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "ReportGeneration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GenerationProviderAttempt" ADD CONSTRAINT "GenerationProviderAttempt_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "ReportAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
