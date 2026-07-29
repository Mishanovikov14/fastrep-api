/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Logger } from '@nestjs/common';
import { StorageCleanupReason } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService } from './object-storage.service';
import { StorageCleanupService } from './storage-cleanup.service';

describe('StorageCleanupService', () => {
  let service: StorageCleanupService;
  let cleanupDelegate: {
    upsert: jest.Mock;
    deleteMany: jest.Mock;
    update: jest.Mock;
    findMany: jest.Mock;
  };
  let storage: {
    deleteObject: jest.Mock;
  };

  beforeEach(() => {
    cleanupDelegate = {
      upsert: jest.fn().mockResolvedValue({ id: 'cleanup-id' }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({
        id: 'cleanup-id',
        reason: StorageCleanupReason.ASSET_DELETE,
        attemptCount: 1,
      }),
      findMany: jest.fn().mockResolvedValue([]),
    };
    storage = {
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      storageCleanupTask: cleanupDelegate,
    } as unknown as PrismaService;
    service = new StorageCleanupService(
      prisma,
      storage as unknown as ObjectStorageService,
    );
  });

  it('persists the key before attempting object deletion', async () => {
    await service.enqueueAndAttempt(
      'known-key',
      StorageCleanupReason.ASSET_DELETE,
    );

    expect(cleanupDelegate.upsert).toHaveBeenCalledWith({
      where: { storageKey: 'known-key' },
      create: {
        storageKey: 'known-key',
        reason: StorageCleanupReason.ASSET_DELETE,
      },
      update: { reason: StorageCleanupReason.ASSET_DELETE },
    });
    expect(cleanupDelegate.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      storage.deleteObject.mock.invocationCallOrder[0],
    );
  });

  it('retains the durable task and emits a structured warning on failure', async () => {
    const warning = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    storage.deleteObject.mockRejectedValue(new Error('provider internals'));
    cleanupDelegate.update.mockResolvedValue({
      id: 'cleanup-id',
      reason: StorageCleanupReason.REPORT_DELETE,
      attemptCount: 1,
    });

    await expect(
      service.enqueueAndAttempt(
        'failed-key',
        StorageCleanupReason.REPORT_DELETE,
      ),
    ).resolves.toBe(false);

    expect(cleanupDelegate.deleteMany).not.toHaveBeenCalled();
    expect(cleanupDelegate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { storageKey: 'failed-key' },
        data: expect.objectContaining({
          attemptCount: { increment: 1 },
        }),
      }),
    );
    expect(warning).toHaveBeenCalledWith({
      event: 'storage_cleanup_deferred',
      cleanupTaskId: 'cleanup-id',
      reason: StorageCleanupReason.REPORT_DELETE,
      attemptCount: 1,
      errorCode: 'OBJECT_STORAGE_DELETE_FAILED',
    });
    expect(JSON.stringify(warning.mock.calls)).not.toContain(
      'provider internals',
    );
  });

  it('removes the durable task after successful cleanup', async () => {
    await expect(
      service.enqueueAndAttempt(
        'missing-or-existing-key',
        StorageCleanupReason.ASSET_DELETE,
      ),
    ).resolves.toBe(true);
    expect(cleanupDelegate.deleteMany).toHaveBeenCalledWith({
      where: { storageKey: 'missing-or-existing-key' },
    });
  });
});
