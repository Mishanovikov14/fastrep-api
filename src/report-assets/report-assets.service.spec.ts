/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ReportAsset,
  ReportAssetStatus,
  ReportAssetType,
  ReportStatus,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService } from '../storage/object-storage.service';
import { ReportAssetLimitsService } from './report-asset-limits.service';
import { ReportAssetsService } from './report-assets.service';

const now = new Date('2026-07-28T12:00:00.000Z');

const createAsset = (overrides: Partial<ReportAsset> = {}): ReportAsset => ({
  id: 'asset-id',
  reportId: 'report-id',
  type: ReportAssetType.IMAGE,
  status: ReportAssetStatus.PENDING_UPLOAD,
  storageKey: 'users/user-id/reports/report-id/assets/asset-id-random-suffix',
  originalFileName: 'photo.jpg',
  declaredMimeType: 'image/jpeg',
  verifiedMimeType: null,
  declaredSize: 6,
  verifiedSize: null,
  position: 0,
  width: null,
  height: null,
  durationSeconds: null,
  rejectionReason: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02]);

const png = (width = 1, height = 1): Uint8Array => {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
};

const webp = (): Uint8Array => {
  const bytes = new Uint8Array(30);
  bytes.set(Buffer.from('RIFF'), 0);
  bytes.set(Buffer.from('WEBP'), 8);
  bytes.set(Buffer.from('VP8X'), 12);
  return bytes;
};

describe('ReportAssetsService', () => {
  let service: ReportAssetsService;
  let reportDelegate: {
    findFirst: jest.Mock;
  };
  let assetDelegate: {
    create: jest.Mock;
    deleteMany: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    updateMany: jest.Mock;
  };
  let storage: {
    createPresignedUpload: jest.Mock;
    headObject: jest.Mock;
    readInspectionBytes: jest.Mock;
    deleteObject: jest.Mock;
  };
  let limits: {
    maximumBytes: jest.Mock;
    maximumCount: jest.Mock;
    maximumReportBytes: jest.Mock;
    maximumImageWidth: jest.Mock;
    maximumImageHeight: jest.Mock;
    maximumAudioDurationSeconds: jest.Mock;
    pendingUploadTtlMinutes: jest.Mock;
  };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    reportDelegate = {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'report-id', status: ReportStatus.DRAFT }),
    };
    assetDelegate = {
      create: jest.fn().mockResolvedValue(createAsset()),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    storage = {
      createPresignedUpload: jest.fn().mockResolvedValue({
        method: 'POST',
        url: 'https://storage.example.test/upload',
        fields: { key: 'opaque-key', policy: 'short-lived-policy' },
        expiresAt: new Date('2026-07-28T12:10:00.000Z'),
      }),
      headObject: jest.fn(),
      readInspectionBytes: jest.fn(),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    limits = {
      maximumBytes: jest.fn((type: ReportAssetType) => {
        switch (type) {
          case ReportAssetType.IMAGE:
            return 10_485_760;
          case ReportAssetType.AUDIO:
            return 52_428_800;
          case ReportAssetType.DOCUMENT:
            return 26_214_400;
        }
      }),
      maximumCount: jest.fn().mockReturnValue(20),
      maximumReportBytes: jest.fn().mockReturnValue(157_286_400),
      maximumImageWidth: jest.fn().mockReturnValue(4096),
      maximumImageHeight: jest.fn().mockReturnValue(4096),
      maximumAudioDurationSeconds: jest.fn().mockReturnValue(1200),
      pendingUploadTtlMinutes: jest.fn().mockReturnValue(30),
    };
    const prisma = {
      report: reportDelegate,
      reportAsset: assetDelegate,
      $transaction: jest.fn(
        (
          callback: (transaction: {
            report: typeof reportDelegate;
            reportAsset: typeof assetDelegate;
          }) => Promise<unknown>,
        ) =>
          callback({
            report: reportDelegate,
            reportAsset: assetDelegate,
          }),
      ),
    } as unknown as PrismaService;
    service = new ReportAssetsService(
      prisma,
      storage as unknown as ObjectStorageService,
      limits as unknown as ReportAssetLimitsService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('requestUpload', () => {
    const request = {
      type: ReportAssetType.IMAGE,
      fileName: '../../private/photo.jpg',
      mimeType: 'image/jpeg',
      size: 1000,
    };

    it('creates a pending asset and returns a direct upload contract', async () => {
      assetDelegate.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await service.requestUpload(
        'user-id',
        'report-id',
        request,
      );

      expect(result).toMatchObject({
        assetId: expect.any(String),
        upload: {
          method: 'POST',
          url: 'https://storage.example.test/upload',
        },
      });
      expect(assetDelegate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          reportId: 'report-id',
          type: ReportAssetType.IMAGE,
          status: ReportAssetStatus.PENDING_UPLOAD,
          originalFileName: 'photo.jpg',
          declaredMimeType: 'image/jpeg',
          declaredSize: 1000,
          position: 0,
        }),
      });
    });

    it('uses an opaque server-generated key that filename traversal cannot influence', async () => {
      assetDelegate.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.requestUpload('user-id', 'report-id', request);

      const createCall = assetDelegate.create.mock.calls[0][0] as {
        data: { id: string; storageKey: string };
      };
      expect(createCall.data.storageKey).toMatch(
        new RegExp(
          `^users/user-id/reports/report-id/assets/${createCall.data.id}-`,
        ),
      );
      expect(createCall.data.storageKey).not.toContain('photo.jpg');
      expect(createCall.data.storageKey).not.toContain('..');
      expect(storage.createPresignedUpload).toHaveBeenCalledWith(
        createCall.data.storageKey,
        'image/jpeg',
        1000,
      );
    });

    it('returns 404 without disclosing a foreign report', async () => {
      reportDelegate.findFirst.mockResolvedValue(null);

      await expect(
        service.requestUpload('user-id', 'foreign-report', request),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(assetDelegate.create).not.toHaveBeenCalled();
    });

    it.each(['image/heic', 'image/heif'])(
      'rejects unsupported iOS format %s',
      async (mimeType) => {
        await expect(
          service.requestUpload('user-id', 'report-id', {
            ...request,
            mimeType,
          }),
        ).rejects.toMatchObject({
          response: { code: 'UNSUPPORTED_ASSET_TYPE' },
        });
      },
    );

    it('rejects a MIME that is unsupported for the requested category', async () => {
      await expect(
        service.requestUpload('user-id', 'report-id', {
          ...request,
          mimeType: 'application/pdf',
        }),
      ).rejects.toMatchObject({
        response: { code: 'UNSUPPORTED_ASSET_TYPE' },
      });
    });

    it.each([
      [ReportAssetType.IMAGE, 'image/jpeg', 10_485_761],
      [ReportAssetType.AUDIO, 'audio/mpeg', 52_428_801],
      [ReportAssetType.DOCUMENT, 'application/pdf', 26_214_401],
    ])('rejects an oversized %s upload', async (type, mimeType, size) => {
      await expect(
        service.requestUpload('user-id', 'report-id', {
          type,
          fileName: 'upload.bin',
          mimeType,
          size,
        }),
      ).rejects.toMatchObject({
        response: { code: 'ASSET_TOO_LARGE' },
      });
    });

    it('enforces the per-type asset count', async () => {
      limits.maximumCount.mockReturnValue(1);
      assetDelegate.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          type: ReportAssetType.IMAGE,
          status: ReportAssetStatus.READY,
          declaredSize: 100,
          verifiedSize: 100,
          position: 0,
        },
      ]);

      await expect(
        service.requestUpload('user-id', 'report-id', request),
      ).rejects.toMatchObject({
        response: { code: 'REPORT_ASSET_LIMIT_EXCEEDED' },
      });
    });

    it('enforces total report reserved storage', async () => {
      limits.maximumReportBytes.mockReturnValue(1000);
      assetDelegate.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          type: ReportAssetType.DOCUMENT,
          status: ReportAssetStatus.PENDING_UPLOAD,
          declaredSize: 1,
          verifiedSize: null,
          position: 0,
        },
      ]);

      await expect(
        service.requestUpload('user-id', 'report-id', request),
      ).rejects.toMatchObject({
        response: { code: 'REPORT_STORAGE_LIMIT_EXCEEDED' },
      });
    });
  });

  describe('confirmUpload', () => {
    const preparePending = (
      bytes: Uint8Array,
      overrides: Partial<ReportAsset> = {},
    ): ReportAsset => {
      const asset = createAsset({
        declaredSize: bytes.length,
        ...overrides,
      });
      assetDelegate.findFirst.mockResolvedValue(asset);
      storage.headObject.mockResolvedValue({ size: asset.declaredSize });
      storage.readInspectionBytes.mockResolvedValue(bytes);
      assetDelegate.findUniqueOrThrow.mockResolvedValue({
        ...asset,
        status: ReportAssetStatus.READY,
        verifiedMimeType: asset.declaredMimeType,
        verifiedSize: asset.declaredSize,
      });
      return asset;
    };

    it.each([
      ['JPEG', jpeg, 'image/jpeg'],
      ['PNG', png(), 'image/png'],
      ['WebP', webp(), 'image/webp'],
    ])('accepts a valid %s signature', async (_name, bytes, mimeType) => {
      preparePending(bytes, { declaredMimeType: mimeType });

      await expect(
        service.confirmUpload('user-id', 'report-id', 'asset-id'),
      ).resolves.toMatchObject({
        status: ReportAssetStatus.READY,
        verifiedMimeType: mimeType,
      });
      expect(assetDelegate.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: ReportAssetStatus.READY,
            verifiedMimeType: mimeType,
            verifiedSize: bytes.length,
          }),
        }),
      );
    });

    it('rejects a missing object and marks the upload rejected', async () => {
      preparePending(jpeg);
      storage.headObject.mockResolvedValue(null);

      await expect(
        service.confirmUpload('user-id', 'report-id', 'asset-id'),
      ).rejects.toMatchObject({
        response: { code: 'UPLOAD_NOT_FOUND' },
      });
      expect(storage.deleteObject).toHaveBeenCalled();
      expect(assetDelegate.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: ReportAssetStatus.REJECTED,
          }),
        }),
      );
    });

    it('rejects a zero-byte object', async () => {
      preparePending(jpeg);
      storage.headObject.mockResolvedValue({ size: 0 });

      await expect(
        service.confirmUpload('user-id', 'report-id', 'asset-id'),
      ).rejects.toMatchObject({
        response: { code: 'UPLOAD_CONTENT_MISMATCH' },
      });
    });

    it('rejects and deletes an object above the actual type limit', async () => {
      preparePending(jpeg, { declaredSize: 10_485_761 });
      storage.headObject.mockResolvedValue({ size: 10_485_761 });

      await expect(
        service.confirmUpload('user-id', 'report-id', 'asset-id'),
      ).rejects.toMatchObject({
        response: { code: 'ASSET_TOO_LARGE' },
      });
      expect(storage.deleteObject).toHaveBeenCalled();
    });

    it('rejects and deletes a declared JPEG containing PDF data', async () => {
      const pdf = Uint8Array.from(Buffer.from('%PDF-1.7'));
      preparePending(pdf, { declaredMimeType: 'image/jpeg' });

      await expect(
        service.confirmUpload('user-id', 'report-id', 'asset-id'),
      ).rejects.toMatchObject({
        response: { code: 'UPLOAD_CONTENT_MISMATCH' },
      });
      expect(storage.deleteObject).toHaveBeenCalled();
    });

    it('rejects excessive detected image dimensions', async () => {
      const bytes = png(4097, 1);
      preparePending(bytes, { declaredMimeType: 'image/png' });

      await expect(
        service.confirmUpload('user-id', 'report-id', 'asset-id'),
      ).rejects.toMatchObject({
        response: { code: 'INVALID_IMAGE_DIMENSIONS' },
      });
      expect(storage.deleteObject).toHaveBeenCalled();
    });

    it('returns an already-ready asset without touching storage', async () => {
      assetDelegate.findFirst.mockResolvedValue(
        createAsset({
          status: ReportAssetStatus.READY,
          verifiedMimeType: 'image/jpeg',
          verifiedSize: 6,
        }),
      );

      await expect(
        service.confirmUpload('user-id', 'report-id', 'asset-id'),
      ).resolves.toMatchObject({ status: ReportAssetStatus.READY });
      expect(storage.headObject).not.toHaveBeenCalled();
    });

    it('returns the concurrent READY result when another confirm wins', async () => {
      const asset = preparePending(jpeg);
      assetDelegate.updateMany.mockResolvedValue({ count: 0 });
      assetDelegate.findFirst
        .mockResolvedValueOnce(asset)
        .mockResolvedValueOnce({
          ...asset,
          status: ReportAssetStatus.READY,
          verifiedMimeType: 'image/jpeg',
          verifiedSize: 6,
        });

      await expect(
        service.confirmUpload('user-id', 'report-id', 'asset-id'),
      ).resolves.toMatchObject({ status: ReportAssetStatus.READY });
    });

    it('returns 404 for a foreign asset/report combination', async () => {
      assetDelegate.findFirst.mockResolvedValue(null);

      await expect(
        service.confirmUpload('user-id', 'report-id', 'foreign-asset'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('lists only ready assets in stable order', async () => {
    const ready = createAsset({ status: ReportAssetStatus.READY });
    assetDelegate.findMany.mockResolvedValue([ready]);

    await expect(service.list('user-id', 'report-id')).resolves.toEqual([
      ready,
    ]);
    expect(assetDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          reportId: 'report-id',
          status: ReportAssetStatus.READY,
        },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      }),
    );
  });

  it('deletes storage before deleting asset metadata', async () => {
    const asset = createAsset({ status: ReportAssetStatus.READY });
    assetDelegate.findFirst.mockResolvedValue(asset);

    await service.delete('user-id', 'report-id', 'asset-id');

    expect(storage.deleteObject).toHaveBeenCalledWith(asset.storageKey);
    expect(assetDelegate.deleteMany).toHaveBeenCalledWith({
      where: { id: 'asset-id', reportId: 'report-id' },
    });
    expect(storage.deleteObject.mock.invocationCallOrder[0]).toBeLessThan(
      assetDelegate.deleteMany.mock.invocationCallOrder[0],
    );
  });

  it('retains asset metadata when storage deletion fails', async () => {
    assetDelegate.findFirst.mockResolvedValue(createAsset());
    storage.deleteObject.mockRejectedValue(new Error('provider detail'));

    await expect(
      service.delete('user-id', 'report-id', 'asset-id'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(assetDelegate.deleteMany).not.toHaveBeenCalled();
  });

  it('cleans expired pending uploads while leaving active uploads intact', async () => {
    const expired = createAsset({
      id: 'expired',
      createdAt: new Date('2026-07-28T11:00:00.000Z'),
    });
    assetDelegate.findMany.mockResolvedValue([
      { id: expired.id, storageKey: expired.storageKey },
    ]);

    await expect(
      service.cleanupExpiredPendingUploads('report-id'),
    ).resolves.toBe(1);
    expect(storage.deleteObject).toHaveBeenCalledWith(expired.storageKey);
    expect(assetDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          reportId: 'report-id',
          status: ReportAssetStatus.PENDING_UPLOAD,
          createdAt: {
            lt: new Date('2026-07-28T11:30:00.000Z'),
          },
        }),
      }),
    );
  });

  it('keeps a stale pending record available when object cleanup fails', async () => {
    assetDelegate.findMany.mockResolvedValue([
      { id: 'expired', storageKey: 'known-storage-key' },
    ]);
    storage.deleteObject.mockRejectedValue(new Error('temporary'));

    await expect(service.cleanupExpiredPendingUploads()).resolves.toBe(0);
    expect(assetDelegate.updateMany).not.toHaveBeenCalled();
  });

  it('aborts report metadata deletion preparation when any object fails', async () => {
    assetDelegate.findMany.mockResolvedValue([
      { storageKey: 'first' },
      { storageKey: 'second' },
    ]);
    storage.deleteObject
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('temporary'));

    await expect(
      service.deleteObjectsForReport('user-id', 'report-id'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('returns controlled errors without provider implementation details', async () => {
    assetDelegate.findFirst.mockResolvedValue(createAsset());
    storage.headObject.mockRejectedValue(
      new Error('secret provider endpoint and signature'),
    );

    await expect(
      service.confirmUpload('user-id', 'report-id', 'asset-id'),
    ).rejects.toMatchObject({
      response: {
        message: 'Object storage is temporarily unavailable',
      },
    });
  });
});

describe('asset error shape', () => {
  it('uses Nest controlled bad-request responses', () => {
    const error = new BadRequestException({
      code: 'UPLOAD_CONTENT_MISMATCH',
      message: 'Mismatch',
    });
    expect(error.getResponse()).toEqual({
      code: 'UPLOAD_CONTENT_MISMATCH',
      message: 'Mismatch',
    });
  });
});
