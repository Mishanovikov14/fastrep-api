import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { REPORT_GENERATION_JOB_NAME } from './generation.constants';

@Injectable()
export class ReportGenerationQueueService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(ReportGenerationQueueService.name);
  private connection?: IORedis;
  private queue?: Queue<{ generationId: string }>;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const redisUrl = this.config.get<string>('REDIS_URL');
    if (!redisUrl) {
      return;
    }
    this.connection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    this.connection.on('error', () => {
      this.logger.warn({
        event: 'report_generation_redis_error',
        errorCode: 'GENERATION_QUEUE_UNAVAILABLE',
      });
    });
    this.queue = new Queue(this.queueName, { connection: this.connection });
    this.queue.on('error', () => {
      this.logger.warn({
        event: 'report_generation_queue_error',
        errorCode: 'GENERATION_QUEUE_UNAVAILABLE',
      });
    });
  }

  async enqueue(generationId: string): Promise<void> {
    if (!this.queue) {
      throw new Error('Report generation queue is not configured');
    }
    await this.queue.add(
      REPORT_GENERATION_JOB_NAME,
      { generationId },
      {
        jobId: generationId,
        attempts: this.numberSetting('REPORT_GENERATION_JOB_ATTEMPTS', 2),
        backoff: {
          type: 'exponential',
          delay: this.numberSetting('REPORT_GENERATION_BACKOFF_MS', 30_000),
        },
        removeOnComplete: 500,
        removeOnFail: 1_000,
      },
    );
  }

  async remove(generationId: string): Promise<void> {
    if (!this.queue) {
      throw new Error('Report generation queue is not configured');
    }
    await this.queue.remove(generationId);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue?.close();
    await this.connection?.quit();
  }

  private get queueName(): string {
    return (
      this.config.get<string>('REPORT_GENERATION_QUEUE_NAME') ??
      'report-generation'
    );
  }

  private numberSetting(key: string, fallback: number): number {
    return Number(this.config.get<string>(key) ?? fallback);
  }
}
