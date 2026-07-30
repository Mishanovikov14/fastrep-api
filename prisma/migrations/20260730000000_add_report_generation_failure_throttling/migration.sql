-- AlterTable
ALTER TABLE "Report"
ADD COLUMN "reportGenerationLockedUntil" TIMESTAMP(3),
ADD COLUMN "reportFailureWindowStartedAt" TIMESTAMP(3),
ADD COLUMN "reportConsecutiveFailureCount" INTEGER NOT NULL DEFAULT 0,
ADD CONSTRAINT "Report_reportConsecutiveFailureCount_check"
CHECK ("reportConsecutiveFailureCount" >= 0);

-- Active-generation exclusion is report-scoped. Different reports owned by
-- the same user may generate independently.
DROP INDEX "ReportGeneration_one_active_per_user_key";
