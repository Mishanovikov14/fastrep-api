import { Prisma } from '../../generated/prisma/client';
import { PresignedUploadContract } from '../storage/storage.types';

export const reportAssetSelect = {
  id: true,
  reportId: true,
  type: true,
  status: true,
  originalFileName: true,
  declaredMimeType: true,
  verifiedMimeType: true,
  declaredSize: true,
  verifiedSize: true,
  position: true,
  width: true,
  height: true,
  durationSeconds: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ReportAssetSelect;

export type ReportAssetRecord = Prisma.ReportAssetGetPayload<{
  select: typeof reportAssetSelect;
}>;

export type UploadRequestResult = {
  assetId: string;
  upload: Omit<PresignedUploadContract, 'expiresAt'>;
  expiresAt: Date;
};
