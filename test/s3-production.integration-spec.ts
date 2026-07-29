import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  ReportAsset,
  ReportAssetStatus,
  ReportAssetType,
  ReportStatus,
  StorageCleanupReason,
} from '../generated/prisma/client';
import { AccessTokenGuard } from '../src/auth/access-token.guard';
import { PrismaService } from '../src/prisma/prisma.service';
import { ReportAssetLimitsService } from '../src/report-assets/report-asset-limits.service';
import { ReportAssetsController } from '../src/report-assets/report-assets.controller';
import { ReportAssetsService } from '../src/report-assets/report-assets.service';
import { ObjectStorageService } from '../src/storage/object-storage.service';
import { StorageCleanupService } from '../src/storage/storage-cleanup.service';

const USER_ID = 's3-production-integration-user';
const REPORT_ID = 's3-production-integration-report';
const REQUIRED_S3_VARIABLES = [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const;
const JPEG_BYTES = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=',
  'base64',
);

type UploadContractResponse = {
  assetId: string;
  upload: {
    method: 'POST';
    url: string;
    fields: Record<string, string>;
  };
};

type CleanupTaskRecord = {
  id: string;
  storageKey: string;
  reason: StorageCleanupReason;
  attemptCount: number;
  lastAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

class IntegrationAccessTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const httpRequest = context
      .switchToHttp()
      .getRequest<{ userId?: string }>();
    httpRequest.userId = USER_ID;
    return true;
  }
}

class InMemoryReportAssetPrisma {
  currentAsset: ReportAsset | null = null;
  readonly cleanupTasks = new Map<string, CleanupTaskRecord>();

  readonly report = {
    findFirst: ({
      where,
    }: {
      where: { id?: string; userId?: string };
    }) =>
      Promise.resolve(
        where.id === REPORT_ID && where.userId === USER_ID
          ? { id: REPORT_ID, status: ReportStatus.DRAFT }
          : null,
      ),
  };

  readonly reportAsset = {
    findMany: ({
      where,
    }: {
      where?: {
        reportId?: string;
        status?: ReportAssetStatus;
        createdAt?: { lt?: Date };
      };
    }) => {
      const asset = this.currentAsset;
      if (!asset || (where?.reportId && where.reportId !== asset.reportId)) {
        return Promise.resolve([]);
      }
      if (where?.status && where.status !== asset.status) {
        return Promise.resolve([]);
      }
      if (
        where?.createdAt?.lt &&
        asset.createdAt.getTime() >= where.createdAt.lt.getTime()
      ) {
        return Promise.resolve([]);
      }
      return Promise.resolve([{ ...asset }]);
    },
    create: ({
      data,
    }: {
      data: Pick<
        ReportAsset,
        | 'id'
        | 'reportId'
        | 'type'
        | 'storageKey'
        | 'originalFileName'
        | 'declaredMimeType'
        | 'declaredSize'
        | 'position'
      >;
    }) => {
      const now = new Date();
      this.currentAsset = {
        ...data,
        status: ReportAssetStatus.PENDING_UPLOAD,
        verifiedMimeType: null,
        verifiedSize: null,
        width: null,
        height: null,
        durationSeconds: null,
        rejectionReason: null,
        createdAt: now,
        updatedAt: now,
      };
      return Promise.resolve({ ...this.currentAsset });
    },
    findFirst: ({
      where,
    }: {
      where: { id?: string; reportId?: string };
    }) => {
      const asset = this.currentAsset;
      return Promise.resolve(
        asset &&
          (!where.id || where.id === asset.id) &&
          (!where.reportId || where.reportId === asset.reportId)
          ? { ...asset }
          : null,
      );
    },
    findUnique: ({ where }: { where: { id: string } }) =>
      Promise.resolve(
        this.currentAsset?.id === where.id
          ? { id: this.currentAsset.id }
          : null,
      ),
    findUniqueOrThrow: ({ where }: { where: { id: string } }) => {
      const asset = this.requireAsset(where.id);
      return Promise.resolve(this.publicAsset(asset));
    },
    updateMany: ({
      where,
      data,
    }: {
      where: {
        id: string;
        reportId?: string;
        status?: ReportAssetStatus;
      };
      data: Partial<ReportAsset>;
    }) => {
      const asset = this.currentAsset;
      if (
        !asset ||
        asset.id !== where.id ||
        (where.reportId && asset.reportId !== where.reportId) ||
        (where.status && asset.status !== where.status)
      ) {
        return Promise.resolve({ count: 0 });
      }
      this.currentAsset = { ...asset, ...data, updatedAt: new Date() };
      return Promise.resolve({ count: 1 });
    },
    deleteMany: ({
      where,
    }: {
      where: {
        id: string;
        reportId?: string;
        status?: ReportAssetStatus;
      };
    }) => {
      const asset = this.currentAsset;
      if (
        !asset ||
        asset.id !== where.id ||
        (where.reportId && asset.reportId !== where.reportId) ||
        (where.status && asset.status !== where.status)
      ) {
        return Promise.resolve({ count: 0 });
      }
      this.currentAsset = null;
      return Promise.resolve({ count: 1 });
    },
  };

  readonly storageCleanupTask = {
    findMany: () =>
      Promise.resolve(
        [...this.cleanupTasks.values()].map(({ storageKey }) => ({
          storageKey,
        })),
      ),
    upsert: ({
      where,
      create,
      update,
    }: {
      where: { storageKey: string };
      create: {
        storageKey: string;
        reason: StorageCleanupReason;
      };
      update: { reason: StorageCleanupReason };
    }) => {
      const existing = this.cleanupTasks.get(where.storageKey);
      const now = new Date();
      const task: CleanupTaskRecord = existing
        ? { ...existing, reason: update.reason, updatedAt: now }
        : {
            id: `cleanup-${this.cleanupTasks.size + 1}`,
            storageKey: create.storageKey,
            reason: create.reason,
            attemptCount: 0,
            lastAttemptAt: null,
            createdAt: now,
            updatedAt: now,
          };
      this.cleanupTasks.set(task.storageKey, task);
      return Promise.resolve({ ...task });
    },
    deleteMany: ({ where }: { where: { storageKey: string } }) => {
      const deleted = this.cleanupTasks.delete(where.storageKey);
      return Promise.resolve({ count: deleted ? 1 : 0 });
    },
    update: ({
      where,
      data,
    }: {
      where: { storageKey: string };
      data: {
        attemptCount: { increment: number };
        lastAttemptAt: Date;
      };
    }) => {
      const task = this.cleanupTasks.get(where.storageKey);
      if (!task) {
        throw new Error('Cleanup task not found');
      }
      const updated = {
        ...task,
        attemptCount: task.attemptCount + data.attemptCount.increment,
        lastAttemptAt: data.lastAttemptAt,
        updatedAt: new Date(),
      };
      this.cleanupTasks.set(updated.storageKey, updated);
      return Promise.resolve({
        id: updated.id,
        reason: updated.reason,
        attemptCount: updated.attemptCount,
      });
    },
  };

  $transaction<T>(
    callback: (client: InMemoryReportAssetPrisma) => Promise<T>,
  ): Promise<T> {
    return callback(this);
  }

  private requireAsset(assetId: string): ReportAsset {
    if (!this.currentAsset || this.currentAsset.id !== assetId) {
      throw new Error('Report asset not found');
    }
    return this.currentAsset;
  }

  private publicAsset(asset: ReportAsset): Omit<ReportAsset, 'storageKey'> {
    const publicAsset = { ...asset };
    Reflect.deleteProperty(publicAsset, 'storageKey');
    return publicAsset;
  }
}

describe('Production S3 report asset flow', () => {
  let app: INestApplication<App>;
  let prisma: InMemoryReportAssetPrisma;
  let storage: ObjectStorageService;
  let uploadedStorageKey: string | null = null;

  beforeAll(async () => {
    if (process.env.RUN_PRODUCTION_S3_INTEGRATION !== 'true') {
      throw new Error(
        'Production S3 integration test must be run through its opt-in npm script',
      );
    }

    const missingVariables = REQUIRED_S3_VARIABLES.filter(
      (name) => !process.env[name],
    );
    if (missingVariables.length > 0) {
      throw new Error(
        `Production S3 configuration is missing: ${missingVariables.join(', ')}`,
      );
    }

    prisma = new InMemoryReportAssetPrisma();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [ReportAssetsController],
      providers: [
        ReportAssetsService,
        ReportAssetLimitsService,
        ObjectStorageService,
        StorageCleanupService,
        {
          provide: PrismaService,
          useValue: prisma,
        },
        {
          provide: ConfigService,
          useValue: new ConfigService(process.env),
        },
      ],
    })
      .overrideGuard(AccessTokenGuard)
      .useClass(IntegrationAccessTokenGuard)
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    storage = moduleFixture.get(ObjectStorageService);
  });

  afterEach(async () => {
    if (!uploadedStorageKey) {
      return;
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await storage.deleteObject(uploadedStorageKey);
        if ((await storage.headObject(uploadedStorageKey)) === null) {
          uploadedStorageKey = null;
          return;
        }
      } catch {
        // Retry the exact test key; never enumerate or modify other objects.
      }
    }

    throw new Error('Production S3 test object cleanup failed');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('uploads, verifies, confirms, and deletes a JPEG', async () => {
    const uploadRequest = await request(app.getHttpServer())
      .post(`/reports/${REPORT_ID}/assets/upload-request`)
      .send({
        type: ReportAssetType.IMAGE,
        fileName: 'production-s3-smoke.jpg',
        mimeType: 'image/jpeg',
        size: JPEG_BYTES.length,
      })
      .expect(201);
    const uploadContract = uploadRequest.body as UploadContractResponse;

    expect(uploadContract.upload.method).toBe('POST');
    expect(uploadContract.upload.url).toMatch(/^https:\/\//u);
    uploadedStorageKey = prisma.currentAsset?.storageKey ?? null;
    expect(uploadedStorageKey).not.toBeNull();

    const form = new FormData();
    for (const [name, value] of Object.entries(
      uploadContract.upload.fields,
    )) {
      form.append(name, value);
    }
    form.append(
      'file',
      new Blob([new Uint8Array(JPEG_BYTES)], { type: 'image/jpeg' }),
      'production-s3-smoke.jpg',
    );

    const uploadResponse = await fetch(uploadContract.upload.url, {
      method: uploadContract.upload.method,
      body: form,
    });
    expect(uploadResponse.status).toBeGreaterThanOrEqual(200);
    expect(uploadResponse.status).toBeLessThan(300);

    const storedObject = await storage.headObject(uploadedStorageKey!);
    expect(storedObject).toEqual({ size: JPEG_BYTES.length });

    const confirmation = await request(app.getHttpServer())
      .post(
        `/reports/${REPORT_ID}/assets/${uploadContract.assetId}/confirm`,
      )
      .expect(200);
    expect(confirmation.body).toMatchObject({
      id: uploadContract.assetId,
      status: ReportAssetStatus.READY,
      verifiedMimeType: 'image/jpeg',
      verifiedSize: JPEG_BYTES.length,
    });
    expect(confirmation.body).not.toHaveProperty('storageKey');

    await request(app.getHttpServer())
      .delete(
        `/reports/${REPORT_ID}/assets/${uploadContract.assetId}`,
      )
      .expect(204);

    expect(await storage.headObject(uploadedStorageKey!)).toBeNull();
    expect(prisma.cleanupTasks.size).toBe(0);
    uploadedStorageKey = null;
  }, 60_000);
});
