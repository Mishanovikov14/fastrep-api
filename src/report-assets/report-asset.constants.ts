import { ReportAssetType } from '../../generated/prisma/client';

export const ALLOWED_MIME_TYPES: Readonly<
  Record<ReportAssetType, readonly string[]>
> = {
  [ReportAssetType.IMAGE]: ['image/jpeg', 'image/png', 'image/webp'],
  [ReportAssetType.AUDIO]: ['audio/mpeg', 'audio/x-m4a', 'audio/wav'],
  [ReportAssetType.DOCUMENT]: [
    'application/pdf',
    'text/plain',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
};

export const ASSET_ERROR_CODES = {
  unsupportedType: 'UNSUPPORTED_ASSET_TYPE',
  tooLarge: 'ASSET_TOO_LARGE',
  reportAssetLimit: 'REPORT_ASSET_LIMIT_EXCEEDED',
  reportStorageLimit: 'REPORT_STORAGE_LIMIT_EXCEEDED',
  uploadNotFound: 'UPLOAD_NOT_FOUND',
  uploadExpired: 'UPLOAD_EXPIRED',
  contentMismatch: 'UPLOAD_CONTENT_MISMATCH',
  invalidImageDimensions: 'INVALID_IMAGE_DIMENSIONS',
  assetNotReady: 'ASSET_NOT_READY',
  uploadSlotConflict: 'UPLOAD_SLOT_CONFLICT',
  storageUnavailable: 'OBJECT_STORAGE_UNAVAILABLE',
} as const;
