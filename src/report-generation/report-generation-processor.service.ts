import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GenerationProviderOperation,
  Prisma,
  ReportAssetType,
  ReportGenerationStage,
  ReportGenerationStatus,
  ReportOutputType,
  ReportStatus,
  StorageCleanupReason,
} from '../../generated/prisma/client';
import {
  AI_PROVIDER,
  AiProviderError,
  ProviderDocumentInput,
} from '../ai/ai-provider.interface';
import type { AiProvider } from '../ai/ai-provider.interface';
import { ReportResult, reportResultSchema } from '../ai/report-result.schema';
import { CreditsService } from '../entitlements/credits.service';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService } from '../storage/object-storage.service';
import { StorageCleanupService } from '../storage/storage-cleanup.service';
import { AssetTranscriptionsService } from './asset-transcriptions.service';
import { GENERATION_PROGRESS } from './generation.constants';
import {
  GenerationProcessResult,
  GenerationInputSnapshot,
  GenerationSnapshotAsset,
} from './generation.types';
import { PdfImage, PdfReportService } from './pdf-report.service';
import { ProviderAttemptsService } from './provider-attempts.service';

export const REPORT_INSTRUCTIONS = `Create a concise, professional report in the requested language using only the supplied source content.
Never invent names, dates, quantities, events, observations, conclusions, or relationships between sources.
Treat every attached PDF, document, photograph, and audio recording as an independent source unless its contents provide direct evidence connecting it to another source.
Never claim that one attachment confirms another merely because both were uploaded to the same report. If sources appear unrelated, describe them separately and state that no relationship can be established from the supplied information.
State uncertainty and material limitations explicitly instead of guessing.
Clearly distinguish facts and direct observations from inferences and recommendations. Never phrase an inference or recommendation as an observed fact.
Use natural source terminology such as "attached PDF", "attached document", "photograph", or "audio recording" according to the actual source type.
Use image aliases only in imageAssetIds. Never include IMAGE_N aliases, asset IDs, report IDs, generation IDs, storage keys, or URLs in titles, prose, bullets, captions, conclusions, or recommendations.
Write natural customer-facing prose without technical image numbering.
Use the dedicated summary, conclusion, and recommendations fields only for those semantic sections. Never add a generic section whose title is equivalent to Summary, Conclusion, or Recommendations in the requested language.
Adapt the generic sections to the useful available content. Prefer detailed findings, observations, source details, inspection details, and limitations when those sections contain meaningful information; omit empty or unsupported sections.
Do not repeat the same fact across sections unless necessary. Keep the executive summary high-level, place evidence and detail in findings, and keep recommendations action-oriented.
Use neutral wording and do not depend on Markdown formatting.`;

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

@Injectable()
export class ReportGenerationProcessorService {
  private readonly logger = new Logger(ReportGenerationProcessorService.name);
  private readonly reportModel: string;
  private readonly jobTimeoutMs: number;
  private readonly failedRetryWindowMs: number;
  private readonly failedRetryLimit: number;
  private readonly failedLockMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly storage: ObjectStorageService,
    private readonly cleanup: StorageCleanupService,
    private readonly credits: CreditsService,
    private readonly transcriptions: AssetTranscriptionsService,
    private readonly attempts: ProviderAttemptsService,
    private readonly pdf: PdfReportService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {
    this.reportModel =
      config.get<string>('OPENAI_REPORT_MODEL') ?? 'gpt-5-mini';
    this.jobTimeoutMs = Number(
      config.get<string>('REPORT_GENERATION_JOB_TIMEOUT_MS') ?? '900000',
    );
    this.failedRetryWindowMs =
      Number(config.get<string>('REPORT_FAILED_RETRY_WINDOW_MINUTES') ?? '3') *
      60_000;
    this.failedRetryLimit = Number(
      config.get<string>('REPORT_FAILED_RETRY_LIMIT') ?? '5',
    );
    this.failedLockMs =
      Number(config.get<string>('REPORT_FAILED_LOCK_MINUTES') ?? '60') * 60_000;
  }

  async process(
    generationId: string,
    queueAttempt: number,
    maximumQueueAttempts: number,
  ): Promise<GenerationProcessResult> {
    const processingToken = randomUUID();
    const claimed = await this.claim(generationId, processingToken);
    if (!claimed) {
      return this.resultAfterClaimLoss(generationId);
    }

    let uploadedOutputKey: string | undefined;
    const temporaryFileIds: string[] = [];
    const startedAt = Date.now();
    const deadline = startedAt + this.jobTimeoutMs;
    const abortController = new AbortController();
    const deadlineTimer = setTimeout(
      () => abortController.abort(),
      this.jobTimeoutMs,
    );
    deadlineTimer.unref();
    const heartbeat = setInterval(() => {
      if (Date.now() >= deadline) {
        abortController.abort();
        return;
      }
      void this.renewLease(generationId, processingToken)
        .then((renewed) => {
          if (!renewed) {
            abortController.abort();
          }
        })
        .catch(() => abortController.abort());
    }, this.heartbeatIntervalMs());
    heartbeat.unref();
    try {
      const generation = await this.prisma.reportGeneration.findUniqueOrThrow({
        where: { id: generationId },
        select: {
          id: true,
          reportId: true,
          userId: true,
          inputSnapshot: true,
          structuredResult: true,
          status: true,
        },
      });
      const snapshot = this.parseSnapshot(generation.inputSnapshot);
      await this.updateProgress(
        generationId,
        ReportGenerationStage.TRANSCRIBING,
        GENERATION_PROGRESS.TRANSCRIBING,
        processingToken,
      );

      const transcriptEntries: Array<{ assetId: string; text: string }> = [];
      const audioAssets = snapshot.assets.filter(
        (asset) => asset.type === ReportAssetType.AUDIO,
      );
      for (let index = 0; index < audioAssets.length; index += 1) {
        this.assertBeforeDeadline(deadline);
        const asset = audioAssets[index];
        const text = await this.transcriptions.getOrCreate(
          generationId,
          asset,
          snapshot.report.language,
          processingToken,
          new Date(deadline),
          abortController.signal,
        );
        transcriptEntries.push({ assetId: asset.id, text });
        const progress =
          GENERATION_PROGRESS.TRANSCRIBING +
          Math.round(((index + 1) / audioAssets.length) * 25);
        await this.updateProgress(
          generationId,
          ReportGenerationStage.TRANSCRIBING,
          progress,
          processingToken,
        );
      }

      await this.updateProgress(
        generationId,
        ReportGenerationStage.ANALYZING,
        GENERATION_PROGRESS.ANALYZING,
        processingToken,
      );
      const imageAssets = snapshot.assets.filter(
        (asset) => asset.type === ReportAssetType.IMAGE,
      );
      this.assertSupportedImageMimeTypes(imageAssets);
      this.assertBeforeDeadline(deadline);
      const moderationImageInputs = await Promise.all(
        imageAssets.map(async (asset) => ({
          assetId: asset.id,
          url: (await this.storage.createPresignedGet(asset.storageKey)).url,
        })),
      );
      const sourceText = this.buildSourceText(snapshot, transcriptEntries);
      if (
        !(await this.attempts.hasCompleted(
          generationId,
          GenerationProviderOperation.MODERATION,
        ))
      ) {
        this.assertBeforeDeadline(deadline);
        const moderationAttempt = await this.attempts.start(
          generationId,
          GenerationProviderOperation.MODERATION,
          'openai',
          'omni-moderation-latest',
          processingToken,
          new Date(deadline),
        );
        try {
          const moderation = await this.provider.moderate(
            sourceText,
            moderationImageInputs.map((image) => image.url),
            abortController.signal,
          );
          if (moderation.value.flagged) {
            throw new AiProviderError(
              'CONTENT_NOT_PROCESSABLE',
              false,
              'The supplied content cannot be processed',
            );
          }
          await this.attempts.completeOwned(
            generationId,
            moderationAttempt.id,
            processingToken,
            {
              providerRequestId: moderation.providerRequestId,
            },
          );
        } catch (error: unknown) {
          const code =
            error instanceof AiProviderError ? error.code : 'AI_UNAVAILABLE';
          await this.attempts.fail(
            moderationAttempt.id,
            code,
            processingToken,
            error instanceof AiProviderError
              ? error.providerRequestId
              : undefined,
          );
          throw error;
        }
      }

      await this.updateProgress(
        generationId,
        ReportGenerationStage.GENERATING_CONTENT,
        GENERATION_PROGRESS.GENERATING_CONTENT,
        processingToken,
      );
      let structuredResult = generation.structuredResult
        ? reportResultSchema.parse(generation.structuredResult)
        : undefined;
      if (!structuredResult) {
        const documents: ProviderDocumentInput[] = [];
        for (const asset of snapshot.assets.filter(
          (candidate) => candidate.type === ReportAssetType.DOCUMENT,
        )) {
          this.assertBeforeDeadline(deadline);
          const stream = await this.storage.getObjectStream(asset.storageKey);
          const fileId = await this.provider.uploadDocument(
            stream,
            asset.originalFileName,
            asset.verifiedMimeType,
            abortController.signal,
          );
          temporaryFileIds.push(fileId);
          documents.push({ assetId: asset.id, fileId });
        }
        const reportAttempt = await this.attempts.start(
          generationId,
          GenerationProviderOperation.REPORT_GENERATION,
          'openai',
          this.reportModel,
          processingToken,
          new Date(deadline),
        );
        try {
          this.assertBeforeDeadline(deadline);
          const reportImageInputs = await Promise.all(
            imageAssets.map(async (asset) => {
              const reference = await this.storage.createPresignedGet(
                asset.storageKey,
              );
              return {
                assetId: asset.id,
                url: reference.url,
                mimeType: asset.verifiedMimeType,
                referenceExpiresAt: reference.expiresAt,
              };
            }),
          );
          const result = await this.provider.generateReport(
            {
              instructions: REPORT_INSTRUCTIONS,
              sourceText,
              images: reportImageInputs,
              documents,
              safetyIdentifier: generation.userId,
              maxOutputTokens: this.numberSetting(
                'AI_MAX_OUTPUT_TOKENS',
                6_000,
              ),
            },
            abortController.signal,
          );
          structuredResult = reportResultSchema.parse(result.value);
          this.validateImageReferences(structuredResult, imageAssets);
          await this.persistReportResult(
            generationId,
            processingToken,
            reportAttempt.id,
            structuredResult,
            result.providerRequestId,
            result.usage?.inputTokens,
            result.usage?.outputTokens,
          );
        } catch (error: unknown) {
          const code =
            error instanceof AiProviderError
              ? error.code
              : 'AI_INVALID_RESPONSE';
          await this.attempts.fail(
            reportAttempt.id,
            code,
            processingToken,
            error instanceof AiProviderError
              ? error.providerRequestId
              : undefined,
          );
          throw error instanceof AiProviderError
            ? error
            : new AiProviderError(
                'AI_INVALID_RESPONSE',
                true,
                'AI response validation failed',
              );
        }
      }
      this.validateImageReferences(structuredResult, imageAssets);

      await this.updateProgress(
        generationId,
        ReportGenerationStage.GENERATING_PDF,
        GENERATION_PROGRESS.GENERATING_PDF,
        processingToken,
      );
      this.assertBeforeDeadline(deadline);
      const pdfImages = await this.loadReferencedImages(
        structuredResult,
        imageAssets,
      );
      const generatedAt = new Date();
      const pdfBytes = await this.pdf.generate(
        structuredResult,
        pdfImages,
        generatedAt,
        snapshot.report.language,
        snapshot.report.title,
        snapshot.report.timezone,
      );
      await this.assertOwnership(generationId, processingToken);

      await this.updateProgress(
        generationId,
        ReportGenerationStage.UPLOADING_OUTPUT,
        GENERATION_PROGRESS.UPLOADING_OUTPUT,
        processingToken,
      );
      this.assertBeforeDeadline(deadline);
      uploadedOutputKey = `users/${generation.userId}/reports/${generation.reportId}/outputs/${generationId}/${processingToken}.pdf`;
      await this.storage.uploadObject(
        uploadedOutputKey,
        pdfBytes,
        'application/pdf',
      );
      await this.finalizeSuccess(
        generationId,
        generation.reportId,
        generation.userId,
        processingToken,
        uploadedOutputKey,
        pdfBytes.byteLength,
      );
      uploadedOutputKey = undefined;
      this.logger.log({
        event: 'report_generation_completed',
        generationId,
        reportId: generation.reportId,
        stage: ReportGenerationStage.COMPLETED,
        attempt: queueAttempt,
        durationMs: Date.now() - startedAt,
      });
    } catch (error: unknown) {
      const providerError = this.normalizeError(error);
      if (providerError.code === 'GENERATION_CLAIM_LOST') {
        if (uploadedOutputKey) {
          await this.scheduleOrphanCleanup(uploadedOutputKey);
        }
        this.logger.warn({
          event: 'report_generation_claim_lost',
          generationId,
          attempt: queueAttempt,
          errorCode: providerError.code,
        });
        return this.resultAfterClaimLoss(generationId);
      }
      if (uploadedOutputKey) {
        await this.scheduleOrphanCleanup(uploadedOutputKey);
        uploadedOutputKey = undefined;
      }
      if (providerError.retryable && queueAttempt < maximumQueueAttempts) {
        const prepared = await this.prepareRetry(
          generationId,
          processingToken,
          providerError.code,
        );
        if (prepared) {
          throw providerError;
        }
        return this.resultAfterClaimLoss(generationId);
      }
      const failed = await this.failGeneration(
        generationId,
        processingToken,
        providerError.code,
        providerError.message,
      );
      if (!failed) {
        return this.resultAfterClaimLoss(generationId);
      }
      this.logger.error({
        event: 'report_generation_failed',
        generationId,
        errorCode: providerError.code,
        attempt: queueAttempt,
        durationMs: Date.now() - startedAt,
      });
    } finally {
      clearTimeout(deadlineTimer);
      clearInterval(heartbeat);
      abortController.abort();
      await Promise.all(
        temporaryFileIds.map((fileId) =>
          this.provider.deleteTemporaryFile(fileId),
        ),
      );
    }
    return { outcome: 'completed' };
  }

  private async claim(
    generationId: string,
    processingToken: string,
  ): Promise<boolean> {
    const now = new Date();
    return this.prisma.$transaction(async (transaction) => {
      const claim = await transaction.reportGeneration.updateMany({
        where: {
          id: generationId,
          OR: [
            { status: ReportGenerationStatus.QUEUED },
            {
              status: ReportGenerationStatus.PROCESSING,
              processingLeaseExpiresAt: { lt: now },
            },
          ],
        },
        data: {
          status: ReportGenerationStatus.PROCESSING,
          processingToken,
          processingLeaseExpiresAt: new Date(now.getTime() + this.jobTimeoutMs),
          startedAt: now,
          attemptCount: { increment: 1 },
        },
      });
      if (claim.count !== 1) {
        return false;
      }
      const generation = await transaction.reportGeneration.findUniqueOrThrow({
        where: { id: generationId },
        select: { reportId: true },
      });
      await transaction.report.updateMany({
        where: {
          id: generation.reportId,
          status: { in: [ReportStatus.QUEUED, ReportStatus.PROCESSING] },
        },
        data: { status: ReportStatus.PROCESSING },
      });
      return true;
    });
  }

  private async finalizeSuccess(
    generationId: string,
    reportId: string,
    userId: string,
    processingToken: string,
    storageKey: string,
    size: number,
  ): Promise<void> {
    return this.prisma.$transaction(async (transaction) => {
      const owned = await transaction.reportGeneration.findFirst({
        where: {
          id: generationId,
          userId,
          status: ReportGenerationStatus.PROCESSING,
          processingToken,
          processingLeaseExpiresAt: { gt: new Date() },
        },
        select: { id: true },
      });
      if (!owned) {
        throw this.claimLost();
      }
      await transaction.reportOutput.create({
        data: {
          reportId,
          generationId,
          type: ReportOutputType.PDF,
          storageKey,
          mimeType: 'application/pdf',
          size,
        },
      });
      const completed = await transaction.reportGeneration.updateMany({
        where: {
          id: generationId,
          userId,
          status: ReportGenerationStatus.PROCESSING,
          processingToken,
        },
        data: {
          status: ReportGenerationStatus.COMPLETED,
          stage: ReportGenerationStage.COMPLETED,
          progress: GENERATION_PROGRESS.COMPLETED,
          completedAt: new Date(),
          processingToken: null,
          processingLeaseExpiresAt: null,
        },
      });
      if (completed.count !== 1) {
        throw this.claimLost();
      }
      await transaction.report.update({
        where: { id: reportId, userId },
        data: {
          status: ReportStatus.READY,
          reportConsecutiveFailureCount: 0,
          reportFailureWindowStartedAt: null,
          reportGenerationLockedUntil: null,
        },
      });
      await this.credits.consumeInTransaction(transaction, generationId);
    });
  }

  private async prepareRetry(
    generationId: string,
    processingToken: string,
    errorCode: string,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.reportGeneration.updateMany({
        where: {
          id: generationId,
          status: ReportGenerationStatus.PROCESSING,
          processingToken,
          processingLeaseExpiresAt: { gt: new Date() },
        },
        data: {
          status: ReportGenerationStatus.QUEUED,
          errorCode,
          errorMessage: 'A temporary dependency error occurred; retrying',
          processingToken: null,
          processingLeaseExpiresAt: null,
        },
      });
      if (updated.count !== 1) {
        return false;
      }
      const generation = await transaction.reportGeneration.findUniqueOrThrow({
        where: { id: generationId },
        select: { reportId: true },
      });
      await transaction.report.updateMany({
        where: {
          id: generation.reportId,
          status: ReportStatus.PROCESSING,
        },
        data: { status: ReportStatus.QUEUED },
      });
      return true;
    });
  }

  private async failGeneration(
    generationId: string,
    processingToken: string,
    errorCode: string,
    message: string,
  ): Promise<boolean> {
    const generation = await this.prisma.$transaction(async (transaction) => {
      const now = new Date();
      const failed = await transaction.reportGeneration.updateMany({
        where: {
          id: generationId,
          status: ReportGenerationStatus.PROCESSING,
          processingToken,
          processingLeaseExpiresAt: { gt: new Date() },
        },
        data: {
          status: ReportGenerationStatus.FAILED,
          errorCode,
          errorMessage: message.slice(0, 300),
          completedAt: now,
          processingToken: null,
          processingLeaseExpiresAt: null,
        },
      });
      if (failed.count !== 1) {
        return undefined;
      }
      const owned = await transaction.reportGeneration.findUniqueOrThrow({
        where: { id: generationId },
        select: { reportId: true },
      });
      const report = await transaction.report.findUniqueOrThrow({
        where: { id: owned.reportId },
        select: {
          reportFailureWindowStartedAt: true,
          reportConsecutiveFailureCount: true,
          output: { select: { id: true } },
        },
      });
      const failureWindowElapsedMs =
        report.reportFailureWindowStartedAt === null
          ? undefined
          : now.getTime() - report.reportFailureWindowStartedAt.getTime();
      const withinWindow =
        failureWindowElapsedMs !== undefined &&
        failureWindowElapsedMs >= 0 &&
        failureWindowElapsedMs <= this.failedRetryWindowMs;
      const consecutiveFailures = withinWindow
        ? report.reportConsecutiveFailureCount + 1
        : 1;
      const windowStartedAt = withinWindow
        ? report.reportFailureWindowStartedAt
        : now;
      const lockedUntil =
        consecutiveFailures >= this.failedRetryLimit
          ? new Date(now.getTime() + this.failedLockMs)
          : null;
      await transaction.report.update({
        where: { id: owned.reportId },
        data: {
          status: report.output ? ReportStatus.READY : ReportStatus.FAILED,
          reportConsecutiveFailureCount: consecutiveFailures,
          reportFailureWindowStartedAt: windowStartedAt,
          reportGenerationLockedUntil: lockedUntil,
        },
      });
      await this.credits.releaseInTransaction(
        transaction,
        generationId,
        `Terminal failure: ${errorCode}`,
      );
      return owned;
    });
    if (!generation) {
      return false;
    }
    this.logger.warn({
      event: 'generation_credit_released',
      generationId,
      reportId: generation.reportId,
      errorCode,
    });
    return true;
  }

  private async resultAfterClaimLoss(
    generationId: string,
  ): Promise<GenerationProcessResult> {
    const generation = await this.prisma.reportGeneration.findUnique({
      where: { id: generationId },
      select: {
        status: true,
        processingLeaseExpiresAt: true,
      },
    });
    if (generation?.status !== ReportGenerationStatus.PROCESSING) {
      return { outcome: 'completed' };
    }
    const now = Date.now();
    const leaseExpiration =
      generation.processingLeaseExpiresAt?.getTime() ?? now;
    return {
      outcome: 'deferred',
      retryAt: new Date(Math.max(now + 1_000, leaseExpiration + 1_000)),
    };
  }

  private async scheduleOrphanCleanup(storageKey: string): Promise<void> {
    await this.prisma.storageCleanupTask.upsert({
      where: { storageKey },
      create: { storageKey, reason: StorageCleanupReason.ORPHAN_OUTPUT },
      update: { reason: StorageCleanupReason.ORPHAN_OUTPUT },
    });
    try {
      await this.cleanup.attemptMany([storageKey]);
    } catch {
      this.logger.warn({
        event: 'orphan_output_cleanup_deferred',
        errorCode: 'STORAGE_CLEANUP_DISPATCH_FAILED',
      });
    }
  }

  private async updateProgress(
    generationId: string,
    stage: ReportGenerationStage,
    progress: number,
    processingToken: string,
  ): Promise<void> {
    const updated = await this.prisma.reportGeneration.updateMany({
      where: {
        id: generationId,
        status: ReportGenerationStatus.PROCESSING,
        processingToken,
        processingLeaseExpiresAt: { gt: new Date() },
      },
      data: {
        stage,
        progress,
        processingLeaseExpiresAt: this.leaseExpiration(),
      },
    });
    if (updated.count !== 1) {
      throw this.claimLost();
    }
  }

  private async persistReportResult(
    generationId: string,
    processingToken: string,
    attemptId: string,
    structuredResult: ReportResult,
    providerRequestId?: string,
    inputTokens?: number,
    outputTokens?: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const owned = await transaction.reportGeneration.findFirst({
        where: {
          id: generationId,
          status: ReportGenerationStatus.PROCESSING,
          processingToken,
          processingLeaseExpiresAt: { gt: new Date() },
        },
        select: { id: true },
      });
      if (!owned) {
        throw this.claimLost();
      }
      await this.attempts.completeInTransaction(
        transaction,
        attemptId,
        processingToken,
        {
          providerRequestId,
          inputTokens,
          outputTokens,
        },
      );
      const updated = await transaction.reportGeneration.updateMany({
        where: {
          id: generationId,
          status: ReportGenerationStatus.PROCESSING,
          processingToken,
        },
        data: {
          structuredResult,
          provider: 'openai',
          model: this.reportModel,
          providerRequestId,
          inputTokens,
          outputTokens,
          processingLeaseExpiresAt: this.leaseExpiration(),
        },
      });
      if (updated.count !== 1) {
        throw this.claimLost();
      }
    });
  }

  private async assertOwnership(
    generationId: string,
    processingToken: string,
  ): Promise<void> {
    if (!(await this.renewLease(generationId, processingToken))) {
      throw this.claimLost();
    }
  }

  private async renewLease(
    generationId: string,
    processingToken: string,
  ): Promise<boolean> {
    const renewed = await this.prisma.reportGeneration.updateMany({
      where: {
        id: generationId,
        status: ReportGenerationStatus.PROCESSING,
        processingToken,
        processingLeaseExpiresAt: { gt: new Date() },
      },
      data: { processingLeaseExpiresAt: this.leaseExpiration() },
    });
    return renewed.count === 1;
  }

  private leaseExpiration(): Date {
    return new Date(Date.now() + this.jobTimeoutMs);
  }

  private heartbeatIntervalMs(): number {
    return Math.max(1_000, Math.min(30_000, Math.floor(this.jobTimeoutMs / 3)));
  }

  private claimLost(): AiProviderError {
    return new AiProviderError(
      'GENERATION_CLAIM_LOST',
      false,
      'Generation processing ownership was lost',
    );
  }

  private buildSourceText(
    snapshot: GenerationInputSnapshot,
    transcripts: Array<{ assetId: string; text: string }>,
  ): string {
    const sourceCounts = new Map<ReportAssetType, number>();
    return JSON.stringify({
      requestedLanguage: snapshot.report.language,
      title: snapshot.report.title,
      notes: snapshot.report.notes,
      assetManifest: snapshot.assets.map((asset) => {
        const sourceNumber = (sourceCounts.get(asset.type) ?? 0) + 1;
        sourceCounts.set(asset.type, sourceNumber);
        return {
          source: `${this.sourceTypeLabel(asset.type)} ${sourceNumber}`,
          type: asset.type,
          mimeType: asset.verifiedMimeType,
          position: asset.position,
        };
      }),
      audioTranscripts: transcripts.map((transcript, index) => ({
        source: `audio recording ${index + 1}`,
        text: transcript.text,
      })),
    });
  }

  private sourceTypeLabel(type: ReportAssetType): string {
    const labels: Record<ReportAssetType, string> = {
      [ReportAssetType.IMAGE]: 'photograph',
      [ReportAssetType.DOCUMENT]: 'attached document',
      [ReportAssetType.AUDIO]: 'audio recording',
    };
    return labels[type];
  }

  private validateImageReferences(
    result: ReportResult,
    images: GenerationSnapshotAsset[],
  ): void {
    const allowedIds = new Set(images.map((image) => image.id));
    const invalid = result.sections
      .flatMap((section) => section.imageAssetIds)
      .some((id) => !allowedIds.has(id));
    if (invalid) {
      throw new AiProviderError(
        'AI_INVALID_IMAGE_REFERENCE',
        false,
        'AI response referenced an unavailable image',
      );
    }
  }

  private assertSupportedImageMimeTypes(
    images: GenerationSnapshotAsset[],
  ): void {
    const invalidImageIndex = images.findIndex(
      (image) => !SUPPORTED_IMAGE_MIME_TYPES.has(image.verifiedMimeType),
    );
    if (invalidImageIndex >= 0) {
      throw new AiProviderError(
        'AI_UNSUPPORTED_IMAGE_MIME',
        false,
        'A report image has an unsupported format',
        undefined,
        {
          invalidImageAssetId: images[invalidImageIndex].id,
          invalidImageIndex,
          invalidImageMimeType: images[invalidImageIndex].verifiedMimeType,
        },
      );
    }
  }

  private async loadReferencedImages(
    result: ReportResult,
    images: GenerationSnapshotAsset[],
  ): Promise<PdfImage[]> {
    const referenced = new Set(
      result.sections.flatMap((section) => section.imageAssetIds),
    );
    const selected = images.filter((image) => referenced.has(image.id));
    const loaded: PdfImage[] = [];
    for (const image of selected) {
      loaded.push({
        assetId: image.id,
        bytes: await this.storage.readObjectBytes(
          image.storageKey,
          image.verifiedSize,
        ),
      });
    }
    return loaded;
  }

  private parseSnapshot(
    value: Prisma.JsonValue | null,
  ): GenerationInputSnapshot {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !('version' in value) ||
      value.version !== 1 ||
      !('report' in value) ||
      !('assets' in value) ||
      !Array.isArray(value.assets)
    ) {
      throw new AiProviderError(
        'INVALID_INPUT_SNAPSHOT',
        false,
        'Generation input snapshot is invalid',
      );
    }
    return value as unknown as GenerationInputSnapshot;
  }

  private normalizeError(error: unknown): AiProviderError {
    if (error instanceof AiProviderError) {
      return error;
    }
    return new AiProviderError(
      'GENERATION_DEPENDENCY_UNAVAILABLE',
      true,
      'Report generation failed because a dependency is unavailable',
    );
  }

  private assertBeforeDeadline(deadline: number): void {
    if (Date.now() >= deadline) {
      throw new AiProviderError(
        'GENERATION_TIMEOUT',
        true,
        'Report generation exceeded its processing deadline',
      );
    }
  }

  private numberSetting(key: string, fallback: number): number {
    return Number(this.config.get<string>(key) ?? fallback);
  }
}
