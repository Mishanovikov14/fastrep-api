import {
  ReportAssetType,
  ReportGenerationStage,
  ReportGenerationStatus,
} from '../../generated/prisma/client';

export type GenerationSnapshotAsset = {
  id: string;
  type: ReportAssetType;
  verifiedMimeType: string;
  verifiedSize: number;
  position: number;
  storageKey: string;
  originalFileName: string;
};

export type GenerationInputSnapshot = {
  version: 1;
  report: {
    id: string;
    title: string;
    notes: string | null;
    language: string;
  };
  assets: GenerationSnapshotAsset[];
  createdAt: string;
};

export type PublicGeneration = {
  id: string;
  status: ReportGenerationStatus;
  stage: ReportGenerationStage;
  progress: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
};

export type GenerationProcessResult =
  { outcome: 'completed' } | { outcome: 'deferred'; retryAt: Date };
