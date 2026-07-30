import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  ReportAssetStatus,
  ReportGenerationStatus,
  ReportStatus,
} from '../../generated/prisma/client';
import {
  conflict,
  forbidden,
  notFound,
  tooManyRequests,
  unavailable,
} from '../common/errors/api-error';
import { CreditsService } from '../entitlements/credits.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  REPORT_PROMPT_VERSION,
  SERIALIZABLE_RETRY_LIMIT,
} from './generation.constants';
import { publicGenerationSelect } from './generation.select';
import { ReportGenerationQueueService } from './report-generation-queue.service';
import { GenerationInputSnapshot, PublicGeneration } from './generation.types';

const queuedGenerationSelect = {
  ...publicGenerationSelect,
  enqueuedAt: true,
} satisfies Prisma.ReportGenerationSelect;

type QueuedGeneration = PublicGeneration & { enqueuedAt: Date | null };

@Injectable()
export class ReportGenerationsService {
  private readonly logger = new Logger(ReportGenerationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly credits: CreditsService,
    private readonly queue: ReportGenerationQueueService,
  ) {}

  async create(
    userId: string,
    reportId: string,
    idempotencyKey: string,
  ): Promise<PublicGeneration> {
    return this.start(userId, reportId, idempotencyKey);
  }

  async latest(userId: string, reportId: string): Promise<PublicGeneration> {
    await this.assertOwnedReport(userId, reportId);
    const generation = await this.prisma.reportGeneration.findFirst({
      where: { reportId, userId },
      orderBy: { createdAt: 'desc' },
      select: publicGenerationSelect,
    });
    if (!generation) {
      throw notFound('GENERATION_NOT_FOUND', 'Generation not found');
    }
    return generation;
  }

  async findOne(
    userId: string,
    reportId: string,
    generationId: string,
  ): Promise<PublicGeneration> {
    const generation = await this.prisma.reportGeneration.findFirst({
      where: { id: generationId, reportId, userId },
      select: publicGenerationSelect,
    });
    if (!generation) {
      throw notFound('GENERATION_NOT_FOUND', 'Generation not found');
    }
    return generation;
  }

  async retry(
    userId: string,
    reportId: string,
    generationId: string,
    idempotencyKey: string,
  ): Promise<PublicGeneration> {
    await this.findOne(userId, reportId, generationId);
    return this.start(userId, reportId, idempotencyKey);
  }

  async cancel(
    userId: string,
    reportId: string,
    generationId: string,
  ): Promise<PublicGeneration> {
    const generation = await this.findOne(userId, reportId, generationId);
    if (generation.status !== ReportGenerationStatus.QUEUED) {
      throw conflict(
        'GENERATION_NOT_CANCELLABLE',
        'Only a queued generation can be cancelled',
      );
    }

    try {
      await this.queue.remove(generationId);
    } catch {
      this.logger.warn({
        event: 'generation_queue_cancel_failed',
        generationId,
        reportId,
        errorCode: 'GENERATION_QUEUE_UNAVAILABLE',
      });
      throw unavailable(
        'GENERATION_QUEUE_UNAVAILABLE',
        'Generation cancellation is temporarily unavailable',
      );
    }

    const cancelled = await this.prisma.$transaction(async (transaction) => {
      const current = await transaction.reportGeneration.findFirst({
        where: {
          id: generationId,
          reportId,
          userId,
          status: ReportGenerationStatus.QUEUED,
        },
        select: { priorReportStatus: true },
      });
      if (!current) {
        throw conflict(
          'GENERATION_NOT_CANCELLABLE',
          'Generation processing has already started',
        );
      }
      const result = await transaction.reportGeneration.updateMany({
        where: {
          id: generationId,
          reportId,
          userId,
          status: ReportGenerationStatus.QUEUED,
        },
        data: {
          status: ReportGenerationStatus.CANCELLED,
          cancelledAt: new Date(),
        },
      });
      if (result.count !== 1) {
        throw conflict(
          'GENERATION_NOT_CANCELLABLE',
          'Generation processing has already started',
        );
      }
      await transaction.report.update({
        where: { id: reportId },
        data: { status: current.priorReportStatus },
      });
      await this.credits.releaseInTransaction(
        transaction,
        generationId,
        'Queued generation cancelled',
      );
      return transaction.reportGeneration.findUniqueOrThrow({
        where: { id: generationId },
        select: publicGenerationSelect,
      });
    });
    return cancelled;
  }

  private async start(
    userId: string,
    reportId: string,
    idempotencyKey: string,
  ): Promise<PublicGeneration> {
    if (this.config.get<string>('AI_GENERATION_ENABLED') === 'false') {
      throw unavailable('GENERATION_DISABLED', 'Report generation is disabled');
    }
    if (
      idempotencyKey.length < 1 ||
      idempotencyKey.length > 128 ||
      idempotencyKey !== idempotencyKey.trim() ||
      !/^[\x21-\x7E]+$/.test(idempotencyKey)
    ) {
      throw conflict(
        'INVALID_IDEMPOTENCY_KEY',
        'A valid Idempotency-Key header is required',
      );
    }

    const existing = await this.prisma.reportGeneration.findUnique({
      where: {
        userId_reportId_idempotencyKey: {
          userId,
          reportId,
          idempotencyKey,
        },
      },
      select: queuedGenerationSelect,
    });
    if (existing) {
      return this.ensureEnqueued(existing);
    }

    const generationId = randomUUID();
    let generation: QueuedGeneration | undefined;
    for (let attempt = 1; attempt <= SERIALIZABLE_RETRY_LIMIT; attempt += 1) {
      try {
        generation = await this.prisma.$transaction(
          async (transaction) => {
            const duplicate = await transaction.reportGeneration.findUnique({
              where: {
                userId_reportId_idempotencyKey: {
                  userId,
                  reportId,
                  idempotencyKey,
                },
              },
              select: queuedGenerationSelect,
            });
            if (duplicate) {
              return duplicate;
            }

            const report = await transaction.report.findFirst({
              where: { id: reportId, userId },
              select: {
                id: true,
                title: true,
                notes: true,
                status: true,
                reportGenerationLockedUntil: true,
                reportFailureWindowStartedAt: true,
                reportConsecutiveFailureCount: true,
                user: {
                  select: { language: true, emailVerifiedAt: true },
                },
                assets: {
                  orderBy: { position: 'asc' },
                  select: {
                    id: true,
                    type: true,
                    status: true,
                    verifiedMimeType: true,
                    verifiedSize: true,
                    position: true,
                    storageKey: true,
                    originalFileName: true,
                  },
                },
              },
            });
            if (!report) {
              throw new NotFoundException('Report not found');
            }
            if (!report.user.emailVerifiedAt) {
              throw forbidden(
                'EMAIL_VERIFICATION_REQUIRED',
                'Verify the account email before generating reports',
              );
            }
            if (report.status === ReportStatus.PROCESSING) {
              throw conflict(
                'GENERATION_ALREADY_ACTIVE',
                'A generation is already active',
              );
            }
            this.assertReportUnlocked(report);
            if (
              ![
                ReportStatus.DRAFT,
                ReportStatus.FAILED,
                ReportStatus.READY,
              ].includes(report.status)
            ) {
              throw conflict(
                'REPORT_NOT_EDITABLE',
                'The report is not eligible for generation',
              );
            }
            this.validateSources(report.notes, report.assets);
            await this.enforceStartLimits(transaction, userId);

            const snapshot: GenerationInputSnapshot = {
              version: 1,
              report: {
                id: report.id,
                title: report.title,
                notes: report.notes,
                language: report.user.language,
              },
              assets: report.assets
                .filter((asset) => asset.status === ReportAssetStatus.READY)
                .map((asset) => ({
                  id: asset.id,
                  type: asset.type,
                  verifiedMimeType: asset.verifiedMimeType!,
                  verifiedSize: asset.verifiedSize!,
                  position: asset.position,
                  storageKey: asset.storageKey,
                  originalFileName: asset.originalFileName,
                })),
              createdAt: new Date().toISOString(),
            };
            await transaction.reportGeneration.create({
              data: {
                id: generationId,
                reportId,
                userId,
                idempotencyKey,
                promptVersion: REPORT_PROMPT_VERSION,
                inputSnapshot: snapshot,
                priorReportStatus: report.status,
              },
            });
            await this.credits.reserve(transaction, userId, generationId);
            await transaction.report.update({
              where: { id: reportId },
              data: { status: ReportStatus.PROCESSING },
            });
            return transaction.reportGeneration.findUniqueOrThrow({
              where: { id: generationId },
              select: queuedGenerationSelect,
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        break;
      } catch (error: unknown) {
        if (this.isPrismaError(error, 'P2034')) {
          if (attempt < SERIALIZABLE_RETRY_LIMIT) {
            continue;
          }
          throw conflict(
            'GENERATION_CREDIT_RESERVATION_FAILED',
            'Generation could not be reserved; retry the request',
          );
        }
        if (this.isPrismaError(error, 'P2002')) {
          const duplicate = await this.prisma.reportGeneration.findUnique({
            where: {
              userId_reportId_idempotencyKey: {
                userId,
                reportId,
                idempotencyKey,
              },
            },
            select: queuedGenerationSelect,
          });
          if (duplicate) {
            generation = duplicate;
            break;
          }
          throw conflict(
            'GENERATION_ALREADY_ACTIVE',
            'A generation is already active',
          );
        }
        throw error;
      }
    }
    if (!generation) {
      throw conflict(
        'GENERATION_CREDIT_RESERVATION_FAILED',
        'Generation could not be reserved; retry the request',
      );
    }

    return this.ensureEnqueued(generation);
  }

  private validateSources(
    notes: string | null,
    assets: Array<{ status: ReportAssetStatus }>,
  ): void {
    if (
      assets.some((asset) => asset.status === ReportAssetStatus.PENDING_UPLOAD)
    ) {
      throw conflict(
        'REPORT_HAS_PENDING_UPLOADS',
        'Complete or remove pending uploads before generation',
      );
    }
    if (assets.some((asset) => asset.status === ReportAssetStatus.REJECTED)) {
      throw conflict(
        'REPORT_HAS_REJECTED_ASSETS',
        'Remove rejected assets before generation',
      );
    }
    if (!notes?.trim() && assets.length === 0) {
      throw conflict(
        'REPORT_HAS_NO_CONTENT',
        'Add notes or at least one ready asset',
      );
    }
  }

  private async enforceStartLimits(
    transaction: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    const now = Date.now();
    const windowSeconds = this.numberSetting(
      'GENERATION_START_RATE_WINDOW_SECONDS',
      3_600,
    );
    const dayAgo = new Date(now - 86_400_000);
    const [hourly, daily, globalDaily] = await Promise.all([
      transaction.reportGeneration.count({
        where: {
          userId,
          createdAt: { gte: new Date(now - windowSeconds * 1_000) },
        },
      }),
      transaction.reportGeneration.count({
        where: { userId, createdAt: { gte: dayAgo } },
      }),
      transaction.reportGeneration.count({
        where: { createdAt: { gte: dayAgo } },
      }),
    ]);
    if (hourly >= this.numberSetting('GENERATION_START_RATE_LIMIT', 5)) {
      throw tooManyRequests(
        'GENERATION_RATE_LIMITED',
        'Generation start rate limit reached',
      );
    }
    if (daily >= this.numberSetting('GENERATION_DAILY_SAFETY_LIMIT', 20)) {
      throw tooManyRequests(
        'GENERATION_DAILY_LIMIT_REACHED',
        'Daily generation limit reached',
      );
    }
    if (
      globalDaily >= this.numberSetting('AI_GLOBAL_DAILY_GENERATION_LIMIT', 500)
    ) {
      throw unavailable(
        'GENERATION_DISABLED',
        'Report generation is temporarily unavailable',
      );
    }
  }

  private async ensureEnqueued(
    generation: QueuedGeneration,
  ): Promise<PublicGeneration> {
    if (
      generation.status !== ReportGenerationStatus.QUEUED ||
      generation.enqueuedAt
    ) {
      return this.toPublicGeneration(generation);
    }
    try {
      await this.queue.enqueue(generation.id);
    } catch {
      try {
        await this.compensateQueueFailure(generation.id);
      } catch {
        this.logger.error({
          event: 'generation_enqueue_compensation_failed',
          generationId: generation.id,
          errorCode: 'GENERATION_QUEUE_COMPENSATION_FAILED',
        });
      }
      this.logger.error({
        event: 'generation_enqueue_failed',
        generationId: generation.id,
        errorCode: 'GENERATION_QUEUE_UNAVAILABLE',
      });
      throw unavailable(
        'GENERATION_QUEUE_UNAVAILABLE',
        'Report generation is temporarily unavailable',
      );
    }
    try {
      await this.prisma.reportGeneration.updateMany({
        where: {
          id: generation.id,
          status: ReportGenerationStatus.QUEUED,
          enqueuedAt: null,
        },
        data: { enqueuedAt: new Date() },
      });
    } catch {
      this.logger.warn({
        event: 'generation_enqueue_marker_failed',
        generationId: generation.id,
        errorCode: 'GENERATION_ENQUEUE_MARKER_FAILED',
      });
    }
    return this.toPublicGeneration(generation);
  }

  private async compensateQueueFailure(generationId: string): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const generation = await transaction.reportGeneration.findUnique({
        where: { id: generationId },
        select: {
          id: true,
          reportId: true,
          status: true,
          priorReportStatus: true,
        },
      });
      if (!generation || generation.status !== ReportGenerationStatus.QUEUED) {
        return;
      }
      await this.credits.releaseInTransaction(
        transaction,
        generation.id,
        'Queue enqueue failed',
      );
      await transaction.report.updateMany({
        where: {
          id: generation.reportId,
          status: ReportStatus.PROCESSING,
        },
        data: { status: generation.priorReportStatus },
      });
      await transaction.reportGeneration.delete({
        where: { id: generation.id },
      });
    });
  }

  private toPublicGeneration(generation: QueuedGeneration): PublicGeneration {
    const { enqueuedAt, ...publicGeneration } = generation;
    void enqueuedAt;
    return publicGeneration;
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

  private numberSetting(key: string, fallback: number): number {
    return Number(this.config.get<string>(key) ?? fallback);
  }

  private assertReportUnlocked(report: {
    reportGenerationLockedUntil: Date | null;
    reportConsecutiveFailureCount: number;
  }): void {
    const lockedUntil = report.reportGenerationLockedUntil;
    const now = Date.now();
    if (!lockedUntil || lockedUntil.getTime() <= now) {
      return;
    }
    throw new ConflictException({
      code: 'REPORT_TEMPORARILY_LOCKED',
      message:
        'This report has been temporarily locked because it failed multiple consecutive generation attempts. Please try again later.',
      lockedUntil,
      retryAfterSeconds: Math.ceil((lockedUntil.getTime() - now) / 1_000),
      consecutiveFailures: report.reportConsecutiveFailureCount,
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
}
