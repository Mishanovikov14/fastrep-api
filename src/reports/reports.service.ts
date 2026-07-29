import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  ReportStatus,
  StorageCleanupReason,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageCleanupService } from '../storage/storage-cleanup.service';
import { CreateReportDto } from './dto/create-report.dto';
import { UpdateReportDto } from './dto/update-report.dto';
import {
  PaginatedReports,
  ReportRecord,
  reportSelect,
} from './types/report.types';

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
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
      where: { id, userId },
      data: dto,
    });

    if (updated.count === 0) {
      throw new NotFoundException('Report not found');
    }

    return this.findOne(userId, id);
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
                assets: { select: { storageKey: true } },
              },
            });
            if (!report) {
              throw new NotFoundException('Report not found');
            }

            const keys = report.assets.map((asset) => asset.storageKey);
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
}
