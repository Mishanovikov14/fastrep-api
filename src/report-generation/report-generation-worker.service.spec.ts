import { ConfigService } from '@nestjs/config';
import { DelayedError, Job } from 'bullmq';
import { ReportGenerationProcessorService } from './report-generation-processor.service';
import { ReportGenerationWorkerService } from './report-generation-worker.service';

describe('ReportGenerationWorkerService', () => {
  it('moves a claim-contended job to delayed without completing it', async () => {
    const retryAt = new Date('2026-07-29T12:01:00.000Z');
    const processor = {
      process: jest.fn().mockResolvedValue({
        outcome: 'deferred',
        retryAt,
      }),
    } as unknown as ReportGenerationProcessorService;
    const service = new ReportGenerationWorkerService(
      {} as ConfigService,
      processor,
    );
    const moveToDelayed = jest.fn().mockResolvedValue(undefined);
    const job = {
      name: 'generate-report',
      data: { generationId: 'generation-id' },
      attemptsMade: 0,
      opts: { attempts: 2 },
      token: 'bull-lock-token',
      moveToDelayed,
    } as unknown as Job<{ generationId: string }>;

    await expect(service['handle'](job)).rejects.toBeInstanceOf(DelayedError);
    expect(moveToDelayed).toHaveBeenCalledWith(
      retryAt.getTime(),
      'bull-lock-token',
    );
  });
});
