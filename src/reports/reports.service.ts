import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  Prisma,
  ReportAssetStatus,
  ReportStatus,
  StorageCleanupReason,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService } from '../storage/object-storage.service';
import { StorageCleanupService } from '../storage/storage-cleanup.service';
import { CreateReportDto } from './dto/create-report.dto';
import { UpdateReportDto } from './dto/update-report.dto';
import {
  PaginatedReports,
  ReportRecord,
  reportSelect,
} from './types/report.types';
import {
  assertReportEditable,
  EDITABLE_REPORT_STATUSES,
} from './report-lifecycle';

const REPORT_TITLE_MAX_LENGTH = 120;
const COPY_SUFFIXES: Readonly<Record<string, string>> = {
  de: ' — Kopie',
  en: ' — Copy',
  es: ' — Copia',
  fr: ' — Copie',
  uk: ' — Копія',
};

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService,
    private readonly storageCleanup: StorageCleanupService,
  ) {}

  create(userId: string, dto: CreateReportDto): Promise<ReportRecord> {
    return this.prisma.report.create({
      data: {
        userId,
        title: dto.title,
        notes: dto.notes,
        status: ReportStatus.DRAFT,
      },
      select: reportSelect,
    });
  }

  async findAll(
    userId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedReports> {
    const where: Prisma.ReportWhereInput = { userId };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.report.findMany({
        where,
        select: reportSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.report.count({ where }),
    ]);

    return {
      data,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(userId: string, id: string): Promise<ReportRecord> {
    const report = await this.prisma.report.findFirst({
      where: { id, userId },
      select: reportSelect,
    });

    if (!report) {
      throw new NotFoundException('Report not found');
    }

    return report;
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateReportDto,
  ): Promise<ReportRecord> {
    const updated = await this.prisma.report.updateMany({
      where: {
        id,
        userId,
        status: { in: [...EDITABLE_REPORT_STATUSES] },
      },
      data: dto,
    });

    if (updated.count === 0) {
      const owned = await this.prisma.report.findFirst({
        where: { id, userId },
        select: { id: true, status: true },
      });
      if (!owned) {
        throw new NotFoundException('Report not found');
      }
      assertReportEditable(owned.status);
      throw new ConflictException({
        code: 'REPORT_UPDATE_CONFLICT',
        message: 'The report changed concurrently; retry the request',
      });
    }

    return this.findOne(userId, id);
  }

  async duplicate(userId: string, id: string): Promise<ReportRecord> {
    const source = await this.prisma.report.findFirst({
      where: { id, userId },
      select: {
        id: true,
        title: true,
        notes: true,
        status: true,
        user: { select: { language: true } },
        assets: {
          where: { status: ReportAssetStatus.READY },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            storageKey: true,
            type: true,
            originalFileName: true,
            declaredMimeType: true,
            verifiedMimeType: true,
            declaredSize: true,
            verifiedSize: true,
            position: true,
            width: true,
            height: true,
            durationSeconds: true,
          },
        },
      },
    });
    if (!source) {
      throw new NotFoundException('Report not found');
    }
    if (source.status !== ReportStatus.READY) {
      throw new ConflictException({
        code: 'REPORT_NOT_DUPLICABLE',
        message: 'Only a completed report can be duplicated',
      });
    }

    const duplicateId = randomUUID();
    const assets = source.assets.map((asset) => {
      const id = randomUUID();
      return {
        ...asset,
        id,
        sourceStorageKey: asset.storageKey,
        storageKey: `users/${userId}/reports/${duplicateId}/assets/${id}-${randomUUID()}`,
      };
    });
    const copiedStorageKeys: string[] = [];
    this.logger.log({
      event: 'report_duplicate_started',
      assetCount: assets.length,
    });

    try {
      for (const asset of assets) {
        const metadata = await this.storage.copyObject(
          asset.sourceStorageKey,
          asset.storageKey,
        );
        copiedStorageKeys.push(asset.storageKey);
        if (metadata.size !== (asset.verifiedSize ?? asset.declaredSize)) {
          throw new Error('Copied asset verification failed');
        }
      }

      const duplicate = await this.prisma.report.create({
        data: {
          id: duplicateId,
          userId,
          title: this.duplicateTitle(source.title, source.user.language),
          notes: source.notes,
          status: ReportStatus.DRAFT,
          assets: {
            create: assets.map((asset) => ({
              id: asset.id,
              type: asset.type,
              status: ReportAssetStatus.READY,
              storageKey: asset.storageKey,
              originalFileName: asset.originalFileName,
              declaredMimeType: asset.declaredMimeType,
              verifiedMimeType: asset.verifiedMimeType,
              declaredSize: asset.declaredSize,
              verifiedSize: asset.verifiedSize,
              position: asset.position,
              width: asset.width,
              height: asset.height,
              durationSeconds: asset.durationSeconds,
            })),
          },
        },
        select: reportSelect,
      });
      this.logger.log({
        event: 'report_duplicate_completed',
        assetCount: assets.length,
      });
      return duplicate;
    } catch {
      await this.rollbackDuplicateCopies(copiedStorageKeys);
      this.logger.error({
        event: 'report_duplicate_failed',
        assetCount: assets.length,
        copiedAssetCount: copiedStorageKeys.length,
        errorCode: 'REPORT_DUPLICATION_FAILED',
      });
      throw new ServiceUnavailableException({
        code: 'REPORT_DUPLICATION_FAILED',
        message: 'The report could not be duplicated; retry the request',
      });
    }
  }

  async delete(userId: string, id: string): Promise<void> {
    let storageKeys: string[] = [];

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        storageKeys = await this.prisma.$transaction(
          async (transaction) => {
            const report = await transaction.report.findFirst({
              where: { id, userId },
              select: {
                id: true,
                status: true,
                assets: { select: { storageKey: true } },
                output: { select: { storageKey: true } },
              },
            });
            if (!report) {
              throw new NotFoundException('Report not found');
            }

            if (
              report.status === ReportStatus.QUEUED ||
              report.status === ReportStatus.PROCESSING
            ) {
              throw new ConflictException({
                code: 'REPORT_GENERATION_ACTIVE',
                message:
                  'A report cannot be deleted while generation is active',
              });
            }

            const keys = [
              ...report.assets.map((asset) => asset.storageKey),
              ...(report.output ? [report.output.storageKey] : []),
            ];
            if (keys.length > 0) {
              await transaction.storageCleanupTask.createMany({
                data: keys.map((storageKey) => ({
                  storageKey,
                  reason: StorageCleanupReason.REPORT_DELETE,
                })),
                skipDuplicates: true,
              });
            }

            await transaction.report.delete({
              where: { id: report.id },
            });
            return keys;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          },
        );
        break;
      } catch (error: unknown) {
        if (!this.isPrismaError(error, 'P2034')) {
          throw error;
        }
        if (attempt === 3) {
          throw new ConflictException({
            code: 'REPORT_DELETE_CONFLICT',
            message: 'The report could not be deleted; retry the request',
          });
        }
      }
    }

    try {
      await this.storageCleanup.attemptMany(storageKeys);
    } catch {
      this.logger.warn({
        event: 'report_storage_cleanup_dispatch_failed',
        reportId: id,
        keyCount: storageKeys.length,
        errorCode: 'STORAGE_CLEANUP_DISPATCH_FAILED',
      });
    }
  }

  private isPrismaError(error: unknown, code: string): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === code
    );
  }

  private duplicateTitle(title: string, language: string): string {
    const suffix = COPY_SUFFIXES[language] ?? COPY_SUFFIXES.en;
    const maximumBaseLength = REPORT_TITLE_MAX_LENGTH - [...suffix].length;
    const base = [...title.trim()].slice(0, maximumBaseLength).join('').trim();
    return `${base}${suffix}`;
  }

  private async rollbackDuplicateCopies(storageKeys: string[]): Promise<void> {
    if (storageKeys.length === 0) {
      return;
    }
    try {
      await this.prisma.storageCleanupTask.createMany({
        data: storageKeys.map((storageKey) => ({
          storageKey,
          reason: StorageCleanupReason.DUPLICATE_ROLLBACK,
        })),
        skipDuplicates: true,
      });
      await this.storageCleanup.attemptMany(storageKeys);
    } catch {
      this.logger.error({
        event: 'report_duplicate_cleanup_deferred',
        keyCount: storageKeys.length,
        errorCode: 'STORAGE_CLEANUP_DISPATCH_FAILED',
      });
    }
  }
}
