import { ConfigService } from '@nestjs/config';
import {
  AssetTranscriptionStatus,
  ReportAssetType,
} from '../../generated/prisma/client';
import { AiProvider } from '../ai/ai-provider.interface';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService } from '../storage/object-storage.service';
import { AssetTranscriptionsService } from './asset-transcriptions.service';
import { ProviderAttemptsService } from './provider-attempts.service';

describe('AssetTranscriptionsService', () => {
  it('reuses a completed transcription without S3 or provider calls', async () => {
    const transcriptionDelegate = {
      findUnique: jest.fn().mockResolvedValue({
        status: AssetTranscriptionStatus.COMPLETED,
        text: 'Cached transcript',
      }),
    };
    const prisma = {
      reportAssetTranscription: transcriptionDelegate,
    } as unknown as PrismaService;
    const storage = { getObjectStream: jest.fn() };
    const attempts = { start: jest.fn() };
    const provider = { transcribe: jest.fn() };
    const config = {
      get: jest.fn(() => 'gpt-4o-mini-transcribe'),
    } as unknown as ConfigService;
    const service = new AssetTranscriptionsService(
      prisma,
      storage as unknown as ObjectStorageService,
      attempts as unknown as ProviderAttemptsService,
      provider as unknown as AiProvider,
      config,
    );

    await expect(
      service.getOrCreate(
        'generation-id',
        {
          id: 'asset-id',
          type: ReportAssetType.AUDIO,
          verifiedMimeType: 'audio/mpeg',
          verifiedSize: 100,
          position: 0,
          storageKey: 'private-key',
          originalFileName: 'audio.mp3',
        },
        'en',
        'processing-token',
        new Date('2026-07-29T12:15:00.000Z'),
      ),
    ).resolves.toBe('Cached transcript');
    expect(storage.getObjectStream).not.toHaveBeenCalled();
    expect(attempts.start).not.toHaveBeenCalled();
    expect(provider.transcribe).not.toHaveBeenCalled();
  });
});
