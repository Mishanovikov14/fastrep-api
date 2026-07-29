-- CreateEnum
CREATE TYPE "ReportAssetType" AS ENUM ('IMAGE', 'AUDIO', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "ReportAssetStatus" AS ENUM ('PENDING_UPLOAD', 'READY', 'REJECTED');

-- CreateTable
CREATE TABLE "ReportAsset" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "type" "ReportAssetType" NOT NULL,
    "status" "ReportAssetStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "storageKey" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "declaredMimeType" TEXT NOT NULL,
    "verifiedMimeType" TEXT,
    "declaredSize" INTEGER NOT NULL,
    "verifiedSize" INTEGER,
    "position" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "durationSeconds" DOUBLE PRECISION,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReportAsset_storageKey_key" ON "ReportAsset"("storageKey");

-- CreateIndex
CREATE INDEX "ReportAsset_reportId_position_idx" ON "ReportAsset"("reportId", "position");

-- CreateIndex
CREATE INDEX "ReportAsset_status_createdAt_idx" ON "ReportAsset"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "ReportAsset" ADD CONSTRAINT "ReportAsset_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
