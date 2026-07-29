import { Injectable, Logger } from '@nestjs/common';
import { StorageCleanupReason } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService } from './object-storage.service';

@Injectable()
export class StorageCleanupService {
  private readonly logger = new Logger(StorageCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService,
  ) {}

  async enqueueAndAttempt(
    storageKey: string,
    reason: StorageCleanupReason,
  ): Promise<boolean> {
    await this.prisma.storageCleanupTask.upsert({
      where: { storageKey },
      create: { storageKey, reason },
      update: { reason },
    });

    return this.attempt(storageKey);
  }

  async attemptMany(storageKeys: string[]): Promise<void> {
    await Promise.all(
      storageKeys.map((storageKey) => this.attempt(storageKey)),
    );
  }

  async retryPending(limit = 20): Promise<number> {
    const tasks = await this.prisma.storageCleanupTask.findMany({
      select: { storageKey: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    const outcomes = await Promise.all(
      tasks.map((task) => this.attempt(task.storageKey)),
    );
    return outcomes.filter(Boolean).length;
  }

  private async attempt(storageKey: string): Promise<boolean> {
    try {
      await this.storage.deleteObject(storageKey);
      await this.prisma.storageCleanupTask.deleteMany({
        where: { storageKey },
      });
      return true;
    } catch {
      const task = await this.prisma.storageCleanupTask.update({
        where: { storageKey },
        data: {
          attemptCount: { increment: 1 },
          lastAttemptAt: new Date(),
        },
        select: { id: true, reason: true, attemptCount: true },
      });
      this.logger.warn({
        event: 'storage_cleanup_deferred',
        cleanupTaskId: task.id,
        reason: task.reason,
        attemptCount: task.attemptCount,
        errorCode: 'OBJECT_STORAGE_DELETE_FAILED',
      });
      return false;
    }
  }
}
