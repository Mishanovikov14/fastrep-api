import { ConfigService } from '@nestjs/config';
import { CreditsService } from '../entitlements/credits.service';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService } from '../storage/object-storage.service';
import { StorageCleanupService } from '../storage/storage-cleanup.service';
import { AssetTranscriptionsService } from './asset-transcriptions.service';
import { PdfReportService } from './pdf-report.service';
import { ProviderAttemptsService } from './provider-attempts.service';
import { ReportGenerationProcessorService } from './report-generation-processor.service';

describe('ReportGenerationProcessorService', () => {
  it('is a no-op for a duplicate delivery that cannot claim the generation', async () => {
    const findUniqueOrThrow = jest.fn();
    const prisma = {
      reportGeneration: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUniqueOrThrow,
      },
    } as unknown as PrismaService;
    const provider = {
      generateReport: jest.fn(),
      moderate: jest.fn(),
      transcribe: jest.fn(),
      uploadDocument: jest.fn(),
      deleteTemporaryFile: jest.fn(),
    };
    const config = {
      get: jest.fn((key: string) =>
        key === 'REPORT_GENERATION_JOB_TIMEOUT_MS' ? '900000' : 'gpt-5-mini',
      ),
    } as unknown as ConfigService;
    const service = new ReportGenerationProcessorService(
      prisma,
      config,
      {} as ObjectStorageService,
      {} as StorageCleanupService,
      {} as CreditsService,
      {} as AssetTranscriptionsService,
      {} as ProviderAttemptsService,
      {} as PdfReportService,
      provider,
    );

    await expect(
      service.process('generation-id', 1, 2),
    ).resolves.toBeUndefined();
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
    expect(provider.generateReport).not.toHaveBeenCalled();
  });
});
