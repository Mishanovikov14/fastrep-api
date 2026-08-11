import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  Prisma,
  ReportAssetStatus,
  ReportAssetType,
  ReportStatus,
  StorageCleanupReason,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService } from '../storage/object-storage.service';
import { StorageCleanupService } from '../storage/storage-cleanup.service';
import { StoredObjectMetadata } from '../storage/storage.types';
import { inspectAssetBytes } from './asset-file-inspector';
import { RequestAssetUploadDto } from './dto/request-asset-upload.dto';
import {
  ALLOWED_MIME_TYPES,
  ASSET_ERROR_CODES,
} from './report-asset.constants';
import { ReportAssetLimitsService } from './report-asset-limits.service';
import {
  ReportAssetRecord,
  reportAssetSelect,
  UploadRequestResult,
} from './report-assets.types';

type AssetForVerification = ReportAssetRecord & {
  storageKey: string;
};

const SERIALIZABLE_TRANSACTION_ATTEMPTS = 3;

@Injectable()
export class ReportAssetsService {
  private readonly logger = new Logger(ReportAssetsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService,
    private readonly storageCleanup: StorageCleanupService,
    private readonly limits: ReportAssetLimitsService,
  ) {}

  async requestUpload(
    userId: string,
    reportId: string,
    dto: RequestAssetUploadDto,
  ): Promise<UploadRequestResult> {
    const report = await this.prisma.report.findFirst({
      where: { id: reportId, userId },
      select: { id: true, status: true },
    });

    if (!report) {
      throw new NotFoundException('Report not found');
    }

    if (report.status !== ReportStatus.DRAFT) {
      throw this.assetError(
        ASSET_ERROR_CODES.assetNotReady,
        'Report assets can only be changed while the report is a draft',
      );
    }

    this.validateDeclaredUpload(dto);
    await this.retryDeferredCleanup();
    await this.cleanupExpiredPendingUploads(reportId);

    const assetId = randomUUID();
    const storageKey = `users/${userId}/reports/${reportId}/assets/${assetId}-${randomUUID()}`;
    await this.createPendingAssetWithinLimits(
      userId,
      reportId,
      assetId,
      storageKey,
      dto,
    );

    try {
      const contract = await this.storage.createPresignedUpload(
        storageKey,
        dto.mimeType,
        dto.size,
      );

      return {
        assetId,
        upload: {
          method: contract.method,
          url: contract.url,
          fields: contract.fields,
        },
        expiresAt: contract.expiresAt,
      };
    } catch {
      await this.prisma.reportAsset.deleteMany({
        where: {
          id: assetId,
          status: ReportAssetStatus.PENDING_UPLOAD,
        },
      });
      throw this.storageUnavailable();
    }
  }

  async confirmUpload(
    userId: string,
    reportId: string,
    assetId: string,
  ): Promise<ReportAssetRecord> {
    const asset = await this.findOwnedAsset(userId, reportId, assetId);

    if (asset.status === ReportAssetStatus.READY) {
      return this.publicAsset(asset);
    }

    if (asset.status === ReportAssetStatus.REJECTED) {
      throw this.assetError(
        ASSET_ERROR_CODES.assetNotReady,
        'The upload has been rejected',
      );
    }

    if (asset.createdAt < this.pendingCutoff()) {
      return this.rejectUpload(
        asset,
        ASSET_ERROR_CODES.uploadExpired,
        'The upload request has expired',
      );
    }

    let metadata: StoredObjectMetadata | null;
    try {
      metadata = await this.storage.headObject(asset.storageKey);
    } catch {
      throw this.storageUnavailable();
    }

    if (!metadata) {
      return this.rejectUpload(
        asset,
        ASSET_ERROR_CODES.uploadNotFound,
        'The uploaded object was not found',
      );
    }

    const maximumBytes = this.limits.maximumBytes(asset.type);
    if (metadata.size > maximumBytes) {
      return this.rejectUpload(
        asset,
        ASSET_ERROR_CODES.tooLarge,
        'The uploaded object exceeds its size limit',
      );
    }

    if (metadata.size === 0 || metadata.size !== asset.declaredSize) {
      return this.rejectUpload(
        asset,
        ASSET_ERROR_CODES.contentMismatch,
        'The uploaded object size does not match the request',
      );
    }

    let inspectionBytes: Uint8Array;
    try {
      inspectionBytes = await this.storage.readInspectionBytes(
        asset.storageKey,
      );
    } catch {
      throw this.storageUnavailable();
    }

    const inspection = inspectAssetBytes(inspectionBytes, metadata.size);
    if (
      !inspection ||
      inspection.type !== asset.type ||
      asset.declaredMimeType !== inspection.mimeType
    ) {
      return this.rejectUpload(
        asset,
        ASSET_ERROR_CODES.contentMismatch,
        'The uploaded file content does not match the requested type',
      );
    }

    if (
      inspection.type === ReportAssetType.IMAGE &&
      ((inspection.width !== undefined &&
        inspection.width > this.limits.maximumImageWidth()) ||
        (inspection.height !== undefined &&
          inspection.height > this.limits.maximumImageHeight()))
    ) {
      return this.rejectUpload(
        asset,
        ASSET_ERROR_CODES.invalidImageDimensions,
        'The uploaded image dimensions exceed the allowed maximum',
      );
    }

    if (
      inspection.type === ReportAssetType.AUDIO &&
      inspection.durationSeconds !== undefined &&
      inspection.durationSeconds > this.limits.maximumAudioDurationSeconds()
    ) {
      return this.rejectUpload(
        asset,
        ASSET_ERROR_CODES.contentMismatch,
        'The uploaded audio duration exceeds the allowed maximum',
      );
    }

    const updated = await this.prisma.reportAsset.updateMany({
      where: {
        id: asset.id,
        status: ReportAssetStatus.PENDING_UPLOAD,
      },
      data: {
        status: ReportAssetStatus.READY,
        verifiedMimeType: inspection.mimeType,
        verifiedSize: metadata.size,
        width: inspection.width,
        height: inspection.height,
        durationSeconds: inspection.durationSeconds,
        rejectionReason: null,
      },
    });

    if (updated.count === 0) {
      const concurrentResult = await this.findOwnedAsset(
        userId,
        reportId,
        assetId,
      );
      if (concurrentResult.status === ReportAssetStatus.READY) {
        return this.publicAsset(concurrentResult);
      }

      throw this.assetError(
        ASSET_ERROR_CODES.assetNotReady,
        'The upload is not ready',
      );
    }

    const readyAsset = await this.prisma.reportAsset.findUniqueOrThrow({
      where: { id: asset.id },
      select: reportAssetSelect,
    });
    return readyAsset;
  }

  async list(userId: string, reportId: string): Promise<ReportAssetRecord[]> {
    await this.assertOwnedReport(userId, reportId);

    return this.prisma.reportAsset.findMany({
      where: { reportId },
      select: reportAssetSelect,
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async createDownloadUrl(userId: string, reportId: string, assetId: string) {
    const asset = await this.findOwnedAsset(userId, reportId, assetId);

    if (asset.status !== ReportAssetStatus.READY) {
      throw this.assetError(
        ASSET_ERROR_CODES.assetNotReady,
        'Only ready assets can be downloaded',
      );
    }

    try {
      return await this.storage.createPresignedGet(asset.storageKey);
    } catch {
      this.logger.error({
        event: 'report_asset_download_url_failed',
        assetType: asset.type,
        errorCode: ASSET_ERROR_CODES.storageUnavailable,
      });
      throw this.storageUnavailable();
    }
  }

  async delete(
    userId: string,
    reportId: string,
    assetId: string,
  ): Promise<void> {
    await this.assertEditableReport(userId, reportId);
    const asset = await this.prisma.reportAsset.findFirst({
      where: { id: assetId, reportId },
      select: { id: true, storageKey: true },
    });

    if (!asset) {
      const foreignAsset = await this.prisma.reportAsset.findUnique({
        where: { id: assetId },
        select: { id: true },
      });
      if (foreignAsset) {
        throw new NotFoundException('Report asset not found');
      }

      return;
    }

    await this.prisma.$transaction(async (transaction) => {
      await transaction.storageCleanupTask.upsert({
        where: { storageKey: asset.storageKey },
        create: {
          storageKey: asset.storageKey,
          reason: StorageCleanupReason.ASSET_DELETE,
        },
        update: { reason: StorageCleanupReason.ASSET_DELETE },
      });
      await transaction.reportAsset.deleteMany({
        where: { id: assetId, reportId },
      });
    });

    try {
      await this.storageCleanup.attemptMany([asset.storageKey]);
    } catch {
      this.logger.warn({
        event: 'storage_cleanup_dispatch_failed',
        assetId,
        errorCode: 'STORAGE_CLEANUP_DISPATCH_FAILED',
      });
    }
  }

  async cleanupExpiredPendingUploads(reportId?: string): Promise<number> {
    const expired = await this.prisma.reportAsset.findMany({
      where: {
        reportId,
        status: ReportAssetStatus.PENDING_UPLOAD,
        createdAt: { lt: this.pendingCutoff() },
      },
      select: { id: true, storageKey: true },
    });
    let cleaned = 0;

    for (const asset of expired) {
      try {
        await this.storageCleanup.enqueueAndAttempt(
          asset.storageKey,
          StorageCleanupReason.EXPIRED_UPLOAD,
        );
        const updated = await this.prisma.reportAsset.updateMany({
          where: {
            id: asset.id,
            status: ReportAssetStatus.PENDING_UPLOAD,
          },
          data: {
            status: ReportAssetStatus.REJECTED,
            rejectionReason: ASSET_ERROR_CODES.uploadExpired,
          },
        });
        cleaned += updated.count;
      } catch {
        this.logger.warn({
          event: 'expired_upload_cleanup_deferred',
          assetId: asset.id,
          errorCode: 'STORAGE_CLEANUP_QUEUE_FAILED',
        });
      }
    }

    return cleaned;
  }

  private validateDeclaredUpload(dto: RequestAssetUploadDto): void {
    if (!ALLOWED_MIME_TYPES[dto.type]?.includes(dto.mimeType)) {
      throw this.assetError(
        ASSET_ERROR_CODES.unsupportedType,
        'The requested MIME type is not supported for this asset category',
      );
    }

    if (dto.size > this.limits.maximumBytes(dto.type)) {
      throw this.assetError(
        ASSET_ERROR_CODES.tooLarge,
        'The declared file size exceeds the allowed maximum',
      );
    }
  }

  private async createPendingAssetWithinLimits(
    userId: string,
    reportId: string,
    assetId: string,
    storageKey: string,
    dto: RequestAssetUploadDto,
  ): Promise<void> {
    for (
      let attempt = 1;
      attempt <= SERIALIZABLE_TRANSACTION_ATTEMPTS;
      attempt += 1
    ) {
      try {
        await this.prisma.$transaction(
          async (transaction) => {
            const report = await transaction.report.findFirst({
              where: { id: reportId, userId },
              select: { id: true, status: true },
            });
            if (!report) {
              throw new NotFoundException('Report not found');
            }
            if (report.status !== ReportStatus.DRAFT) {
              throw this.assetError(
                ASSET_ERROR_CODES.assetNotReady,
                'Report assets can only be changed while the report is a draft',
              );
            }

            const activeAssets = await transaction.reportAsset.findMany({
              where: {
                reportId,
                OR: [
                  { status: ReportAssetStatus.READY },
                  {
                    status: ReportAssetStatus.PENDING_UPLOAD,
                    createdAt: { gte: this.pendingCutoff() },
                  },
                ],
              },
              select: {
                type: true,
                declaredSize: true,
                verifiedSize: true,
                position: true,
              },
            });

            const typeCount = activeAssets.filter(
              (asset) => asset.type === dto.type,
            ).length;
            if (typeCount >= this.limits.maximumCount(dto.type)) {
              throw this.assetError(
                ASSET_ERROR_CODES.reportAssetLimit,
                `The report has reached its ${dto.type.toLowerCase()} asset limit`,
              );
            }

            const reservedBytes = activeAssets.reduce(
              (total, asset) =>
                total + (asset.verifiedSize ?? asset.declaredSize),
              0,
            );
            if (reservedBytes + dto.size > this.limits.maximumReportBytes()) {
              throw this.assetError(
                ASSET_ERROR_CODES.reportStorageLimit,
                'The report storage limit would be exceeded',
              );
            }

            const position =
              activeAssets.reduce(
                (maximum, asset) => Math.max(maximum, asset.position),
                -1,
              ) + 1;
            await transaction.reportAsset.create({
              data: {
                id: assetId,
                reportId,
                type: dto.type,
                status: ReportAssetStatus.PENDING_UPLOAD,
                storageKey,
                originalFileName: this.sanitizeFileName(dto.fileName),
                declaredMimeType: dto.mimeType,
                declaredSize: dto.size,
                position,
              },
            });
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          },
        );
        return;
      } catch (error: unknown) {
        if (!this.isPrismaError(error, 'P2034')) {
          throw error;
        }

        if (attempt === SERIALIZABLE_TRANSACTION_ATTEMPTS) {
          throw new ConflictException({
            code: ASSET_ERROR_CODES.uploadSlotConflict,
            message: 'The upload slot could not be reserved; retry the request',
          });
        }
      }
    }
  }

  private async findOwnedAsset(
    userId: string,
    reportId: string,
    assetId: string,
  ): Promise<AssetForVerification> {
    const asset = await this.prisma.reportAsset.findFirst({
      where: {
        id: assetId,
        reportId,
        report: { userId },
      },
      select: {
        ...reportAssetSelect,
        storageKey: true,
      },
    });

    if (!asset) {
      throw new NotFoundException('Report asset not found');
    }

    return asset;
  }

  private async assertOwnedReport(
    userId: string,
    reportId: string,
  ): Promise<void> {
    const report = await this.prisma.report.findFirst({
      where: { id: reportId, userId },
      select: { id: true },
    });

    if (!report) {
      throw new NotFoundException('Report not found');
    }
  }

  private async assertEditableReport(
    userId: string,
    reportId: string,
  ): Promise<void> {
    const report = await this.prisma.report.findFirst({
      where: { id: reportId, userId },
      select: { id: true, status: true },
    });
    if (!report) {
      throw new NotFoundException('Report not found');
    }
    if (report.status !== ReportStatus.DRAFT) {
      throw new ConflictException({
        code: 'REPORT_NOT_EDITABLE',
        message:
          'Report assets can only be changed while the report is a draft',
      });
    }
  }

  private async rejectUpload(
    asset: AssetForVerification,
    code: string,
    message: string,
  ): Promise<never> {
    await this.storageCleanup.enqueueAndAttempt(
      asset.storageKey,
      StorageCleanupReason.REJECTED_UPLOAD,
    );

    await this.prisma.reportAsset.updateMany({
      where: {
        id: asset.id,
        status: ReportAssetStatus.PENDING_UPLOAD,
      },
      data: {
        status: ReportAssetStatus.REJECTED,
        rejectionReason: code,
      },
    });

    throw this.assetError(code, message);
  }

  private publicAsset(asset: AssetForVerification): ReportAssetRecord {
    return {
      id: asset.id,
      reportId: asset.reportId,
      type: asset.type,
      status: asset.status,
      originalFileName: asset.originalFileName,
      declaredMimeType: asset.declaredMimeType,
      verifiedMimeType: asset.verifiedMimeType,
      declaredSize: asset.declaredSize,
      verifiedSize: asset.verifiedSize,
      position: asset.position,
      width: asset.width,
      height: asset.height,
      durationSeconds: asset.durationSeconds,
      rejectionReason: asset.rejectionReason,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
    };
  }

  private pendingCutoff(): Date {
    return new Date(
      Date.now() - this.limits.pendingUploadTtlMinutes() * 60_000,
    );
  }

  private sanitizeFileName(fileName: string): string {
    const displayName =
      [...fileName]
        .filter((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint >= 32 && codePoint !== 127;
        })
        .join('')
        .split(/[\\/]/u)
        .pop()
        ?.trim() ?? '';
    return (displayName || 'upload').slice(0, 255);
  }

  private assetError(code: string, message: string): BadRequestException {
    return new BadRequestException({ code, message });
  }

  private storageUnavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: ASSET_ERROR_CODES.storageUnavailable,
      message: 'Object storage is temporarily unavailable',
    });
  }

  private isPrismaError(error: unknown, code: string): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === code
    );
  }

  private async retryDeferredCleanup(): Promise<void> {
    try {
      await this.storageCleanup.retryPending();
    } catch {
      this.logger.warn({
        event: 'storage_cleanup_retry_failed',
        errorCode: 'STORAGE_CLEANUP_RETRY_FAILED',
      });
    }
  }
}
