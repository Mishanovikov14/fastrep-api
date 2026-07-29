import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DelayedError, Job, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { REPORT_GENERATION_JOB_NAME } from './generation.constants';
import { ReportGenerationProcessorService } from './report-generation-processor.service';

@Injectable()
export class ReportGenerationWorkerService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(ReportGenerationWorkerService.name);
  private connection?: IORedis;
  private worker?: Worker<{ generationId: string }>;

  constructor(
    private readonly config: ConfigService,
    private readonly processor: ReportGenerationProcessorService,
  ) {}

  onModuleInit(): void {
    const redisUrl = this.config.get<string>('REDIS_URL');
    if (!redisUrl) {
      throw new Error('REDIS_URL is required for the generation worker');
    }
    this.connection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    this.connection.on('error', () => {
      this.logger.warn({
        event: 'report_generation_worker_redis_error',
        errorCode: 'GENERATION_QUEUE_UNAVAILABLE',
      });
    });
    this.worker = new Worker(
      this.config.get<string>('REPORT_GENERATION_QUEUE_NAME') ??
        'report-generation',
      (job) => this.handle(job),
      {
        connection: this.connection,
        concurrency: this.numberSetting('REPORT_GENERATION_CONCURRENCY', 1),
        lockDuration: this.numberSetting(
          'REPORT_GENERATION_JOB_TIMEOUT_MS',
          900_000,
        ),
      },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.warn({
        event: 'report_generation_job_failed',
        generationId: job?.data.generationId,
        attempt: job ? job.attemptsMade : undefined,
        errorCode:
          error instanceof Error ? error.name : 'GENERATION_JOB_FAILED',
      });
    });
    this.worker.on('error', () => {
      this.logger.error({
        event: 'report_generation_worker_error',
        errorCode: 'GENERATION_WORKER_UNAVAILABLE',
      });
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.connection?.quit();
  }

  private async handle(job: Job<{ generationId: string }>): Promise<void> {
    if (job.name !== REPORT_GENERATION_JOB_NAME) {
      return;
    }
    const result = await this.processor.process(
      job.data.generationId,
      job.attemptsMade + 1,
      job.opts.attempts ?? 1,
    );
    if (result.outcome === 'deferred') {
      await job.moveToDelayed(result.retryAt.getTime(), job.token);
      throw new DelayedError();
    }
  }

  private numberSetting(key: string, fallback: number): number {
    return Number(this.config.get<string>(key) ?? fallback);
  }
}
