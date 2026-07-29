-- CreateEnum
CREATE TYPE "StorageCleanupReason" AS ENUM ('ASSET_DELETE', 'REPORT_DELETE', 'REJECTED_UPLOAD', 'EXPIRED_UPLOAD');

-- CreateTable
CREATE TABLE "StorageCleanupTask" (
    "id" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "reason" "StorageCleanupReason" NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageCleanupTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StorageCleanupTask_storageKey_key" ON "StorageCleanupTask"("storageKey");

-- CreateIndex
CREATE INDEX "StorageCleanupTask_createdAt_idx" ON "StorageCleanupTask"("createdAt");
