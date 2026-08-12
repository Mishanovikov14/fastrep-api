/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  Report,
  ReportAssetStatus,
  ReportAssetType,
  ReportStatus,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService } from '../storage/object-storage.service';
import { StorageCleanupService } from '../storage/storage-cleanup.service';
import { ReportsService } from './reports.service';

const createReport = (overrides: Partial<Report> = {}): Report => ({
  id: 'report-id',
  userId: 'user-id',
  title: 'Site inspection',
  notes: 'Inspect the roof.',
  status: ReportStatus.DRAFT,
  reportGenerationLockedUntil: null,
  reportFailureWindowStartedAt: null,
  reportConsecutiveFailureCount: 0,
  createdAt: new Date('2026-07-27T10:00:00.000Z'),
  updatedAt: new Date('2026-07-27T10:00:00.000Z'),
  ...overrides,
});

interface DuplicateAssetCreateData {
  id: string;
  originalFileName: string;
  position: number;
  status: ReportAssetStatus;
}

interface DuplicateReportCreateData {
  assets: { create: DuplicateAssetCreateData[] };
  id: string;
  notes: string | null;
  status: ReportStatus;
  title: string;
  userId: string;
}

const readDuplicateCreateData = (
  create: jest.Mock,
): DuplicateReportCreateData => {
  const calls = create.mock.calls as unknown as Array<
    [{ data: DuplicateReportCreateData }]
  >;
  const input = calls[0]?.[0];

  if (!input) {
    throw new Error('Expected report create call');
  }

  return input.data;
};

describe('ReportsService', () => {
  let service: ReportsService;
  let report: Report;
  let reportDelegate: {
    create: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    findFirst: jest.Mock;
    updateMany: jest.Mock;
    deleteMany: jest.Mock;
    delete: jest.Mock;
  };
  let cleanupTaskDelegate: {
    createMany: jest.Mock;
  };
  let storageCleanup: {
    attemptMany: jest.Mock;
  };
  let storage: {
    copyObject: jest.Mock;
  };

  beforeEach(() => {
    report = createReport();
    reportDelegate = {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
      delete: jest.fn(),
    };
    cleanupTaskDelegate = {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    };
    const prisma = {
      report: reportDelegate,
      storageCleanupTask: cleanupTaskDelegate,
      $transaction: jest.fn(
        (
          input:
            | Promise<unknown>[]
            | ((transaction: {
                report: typeof reportDelegate;
                storageCleanupTask: typeof cleanupTaskDelegate;
              }) => Promise<unknown>),
        ) =>
          Array.isArray(input)
            ? Promise.all(input)
            : input({
                report: reportDelegate,
                storageCleanupTask: cleanupTaskDelegate,
              }),
      ),
    } as unknown as PrismaService;

    storageCleanup = {
      attemptMany: jest.fn().mockResolvedValue(undefined),
    };
    storage = {
      copyObject: jest.fn().mockResolvedValue({ size: 1_024 }),
    };
    service = new ReportsService(
      prisma,
      storage as unknown as ObjectStorageService,
      storageCleanup as unknown as StorageCleanupService,
    );
  });

  it('creates a DRAFT report for the authenticated user', async () => {
    reportDelegate.create.mockResolvedValue(report);

    await expect(
      service.create('user-id', {
        title: report.title,
        notes: report.notes ?? undefined,
      }),
    ).resolves.toEqual(report);
    expect(reportDelegate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          userId: 'user-id',
          title: report.title,
          notes: report.notes,
          status: ReportStatus.DRAFT,
        },
      }),
    );
  });

  it('lists only the authenticated user’s reports newest first', async () => {
    reportDelegate.findMany.mockResolvedValue([report]);
    reportDelegate.count.mockResolvedValue(1);

    await service.findAll('user-id', 1, 20);

    expect(reportDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-id' },
        orderBy: { createdAt: 'desc' },
      }),
    );
    expect(reportDelegate.count).toHaveBeenCalledWith({
      where: { userId: 'user-id' },
    });
  });

  it('applies pagination and returns pagination metadata', async () => {
    reportDelegate.findMany.mockResolvedValue([report]);
    reportDelegate.count.mockResolvedValue(45);

    await expect(service.findAll('user-id', 2, 20)).resolves.toEqual({
      data: [report],
      page: 2,
      limit: 20,
      total: 45,
      totalPages: 3,
    });
    expect(reportDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 20 }),
    );
  });

  it('gets an owned report', async () => {
    reportDelegate.findFirst.mockResolvedValue(report);

    await expect(service.findOne('user-id', report.id)).resolves.toEqual(
      report,
    );
    expect(reportDelegate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: report.id, userId: 'user-id' },
      }),
    );
  });

  it('returns 404 for another user’s report', async () => {
    reportDelegate.findFirst.mockResolvedValue(null);

    await expect(
      service.findOne('user-id', 'foreign-report-id'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updates an owned report', async () => {
    const updatedReport = createReport({
      title: 'Updated inspection',
      notes: 'Updated notes.',
    });
    reportDelegate.updateMany.mockResolvedValue({ count: 1 });
    reportDelegate.findFirst.mockResolvedValue(updatedReport);

    await expect(
      service.update('user-id', report.id, {
        title: updatedReport.title,
        notes: updatedReport.notes ?? undefined,
      }),
    ).resolves.toEqual(updatedReport);
    expect(reportDelegate.updateMany).toHaveBeenCalledWith({
      where: {
        id: report.id,
        userId: 'user-id',
        status: { in: [ReportStatus.DRAFT, ReportStatus.FAILED] },
      },
      data: {
        title: updatedReport.title,
        notes: updatedReport.notes,
      },
    });
  });

  it('cannot update another user’s report', async () => {
    reportDelegate.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.update('user-id', 'foreign-report-id', {
        title: 'Not allowed',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(reportDelegate.findFirst).toHaveBeenCalledWith({
      where: { id: 'foreign-report-id', userId: 'user-id' },
      select: { id: true, status: true },
    });
  });

  it('keeps a failed report FAILED when its source is edited', async () => {
    reportDelegate.updateMany.mockResolvedValue({ count: 1 });
    reportDelegate.findFirst.mockResolvedValue(
      createReport({ status: ReportStatus.FAILED }),
    );

    await service.update('user-id', report.id, { notes: 'Corrected notes' });

    expect(reportDelegate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          notes: 'Corrected notes',
        },
      }),
    );
  });

  it.each([
    [ReportStatus.QUEUED, 'REPORT_GENERATION_ACTIVE'],
    [ReportStatus.PROCESSING, 'REPORT_GENERATION_ACTIVE'],
    [ReportStatus.READY, 'REPORT_NOT_EDITABLE'],
  ])('blocks source updates for %s reports', async (status, code) => {
    reportDelegate.updateMany.mockResolvedValue({ count: 0 });
    reportDelegate.findFirst.mockResolvedValue(createReport({ status }));

    const promise = service.update('user-id', report.id, {
      notes: 'Not allowed',
    });

    await expect(promise).rejects.toBeInstanceOf(ConflictException);
    await expect(promise).rejects.toMatchObject({ response: { code } });
  });

  it('duplicates a READY report into an independent DRAFT with copied READY assets', async () => {
    reportDelegate.findFirst.mockResolvedValue({
      id: report.id,
      title: 'Огляд даху',
      notes: report.notes,
      status: ReportStatus.READY,
      user: { language: 'uk' },
      assets: [
        {
          id: 'source-asset-id',
          storageKey: 'source-image',
          type: ReportAssetType.IMAGE,
          originalFileName: 'Photo 1.jpg',
          declaredMimeType: 'image/jpeg',
          verifiedMimeType: 'image/jpeg',
          declaredSize: 1_024,
          verifiedSize: 1_024,
          position: 0,
          width: 100,
          height: 80,
          durationSeconds: null,
        },
      ],
    });
    reportDelegate.create.mockImplementation((input: unknown) => {
      const data = (input as { data: DuplicateReportCreateData }).data;
      return {
        id: data.id,
        userId: data.userId,
        title: data.title,
        notes: data.notes,
        status: data.status,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });

    const duplicate = await service.duplicate('user-id', report.id);

    expect(duplicate).toMatchObject({
      title: 'Огляд даху — Копія',
      status: ReportStatus.DRAFT,
    });
    expect(duplicate.id).not.toBe(report.id);
    expect(storage.copyObject).toHaveBeenCalledWith(
      'source-image',
      expect.stringMatching(
        /^users\/user-id\/reports\/.+\/assets\/.+-[0-9a-f-]+$/u,
      ),
    );
    const createData = readDuplicateCreateData(reportDelegate.create);
    expect(createData.assets.create).toHaveLength(1);
    expect(createData.assets.create[0]).toMatchObject({
      status: ReportAssetStatus.READY,
      originalFileName: 'Photo 1.jpg',
      position: 0,
    });
    expect(createData.assets.create[0]?.id).not.toBe('source-asset-id');
    expect(createData).not.toHaveProperty('generations');
    expect(createData).not.toHaveProperty('output');
    expect(reportDelegate.updateMany).not.toHaveBeenCalled();
    expect(reportDelegate.delete).not.toHaveBeenCalled();
    expect(reportDelegate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: report.id, userId: 'user-id' },
        select: expect.objectContaining({
          assets: expect.objectContaining({
            where: { status: ReportAssetStatus.READY },
          }),
        }),
      }),
    );
  });

  it('truncates a duplicated Unicode title while preserving the suffix', async () => {
    reportDelegate.findFirst.mockResolvedValue({
      id: report.id,
      title: 'Д'.repeat(120),
      notes: null,
      status: ReportStatus.READY,
      user: { language: 'uk' },
      assets: [],
    });
    reportDelegate.create.mockImplementation(
      (input: unknown) => (input as { data: DuplicateReportCreateData }).data,
    );

    await service.duplicate('user-id', report.id);

    const title = readDuplicateCreateData(reportDelegate.create).title;
    expect([...title]).toHaveLength(120);
    expect(title.endsWith(' — Копія')).toBe(true);
  });

  it.each([ReportStatus.DRAFT, ReportStatus.FAILED])(
    'does not duplicate a %s report',
    async (status) => {
      reportDelegate.findFirst.mockResolvedValue({
        id: report.id,
        title: report.title,
        notes: report.notes,
        status,
        user: { language: 'en' },
        assets: [],
      });

      const promise = service.duplicate('user-id', report.id);

      await expect(promise).rejects.toBeInstanceOf(ConflictException);
      await expect(promise).rejects.toMatchObject({
        response: { code: 'REPORT_NOT_DUPLICABLE' },
      });
      expect(storage.copyObject).not.toHaveBeenCalled();
      expect(reportDelegate.create).not.toHaveBeenCalled();
    },
  );

  it('does not expose another user’s report through duplication', async () => {
    reportDelegate.findFirst.mockResolvedValue(null);

    await expect(
      service.duplicate('user-id', 'foreign-report-id'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.copyObject).not.toHaveBeenCalled();
  });

  it('rolls back copied objects when duplication fails before DB publication', async () => {
    reportDelegate.findFirst.mockResolvedValue({
      id: report.id,
      title: report.title,
      notes: report.notes,
      status: ReportStatus.READY,
      user: { language: 'en' },
      assets: [
        {
          id: 'first-source-id',
          storageKey: 'first-source',
          type: ReportAssetType.IMAGE,
          originalFileName: 'Photo 1.jpg',
          declaredMimeType: 'image/jpeg',
          verifiedMimeType: 'image/jpeg',
          declaredSize: 1_024,
          verifiedSize: 1_024,
          position: 0,
          width: 100,
          height: 80,
          durationSeconds: null,
        },
        {
          id: 'second-source-id',
          storageKey: 'second-source',
          type: ReportAssetType.DOCUMENT,
          originalFileName: 'inspection.pdf',
          declaredMimeType: 'application/pdf',
          verifiedMimeType: 'application/pdf',
          declaredSize: 2_048,
          verifiedSize: 2_048,
          position: 1,
          width: null,
          height: null,
          durationSeconds: null,
        },
      ],
    });
    storage.copyObject
      .mockResolvedValueOnce({ size: 1_024 })
      .mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(
      service.duplicate('user-id', report.id),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(reportDelegate.create).not.toHaveBeenCalled();
    expect(cleanupTaskDelegate.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ reason: 'DUPLICATE_ROLLBACK' })],
      skipDuplicates: true,
    });
    expect(storageCleanup.attemptMany).toHaveBeenCalledWith([
      expect.stringContaining('/assets/'),
    ]);
  });

  it('deletes an owned report', async () => {
    reportDelegate.findFirst.mockResolvedValue({
      id: report.id,
      status: ReportStatus.DRAFT,
      assets: [{ storageKey: 'owned-key' }],
      output: { storageKey: 'output-key' },
    });
    reportDelegate.delete.mockResolvedValue(report);

    await expect(service.delete('user-id', report.id)).resolves.toBeUndefined();
    expect(cleanupTaskDelegate.createMany).toHaveBeenCalledWith({
      data: [
        {
          storageKey: 'owned-key',
          reason: 'REPORT_DELETE',
        },
        {
          storageKey: 'output-key',
          reason: 'REPORT_DELETE',
        },
      ],
      skipDuplicates: true,
    });
    expect(reportDelegate.delete).toHaveBeenCalledWith({
      where: { id: report.id },
    });
    expect(storageCleanup.attemptMany).toHaveBeenCalledWith([
      'owned-key',
      'output-key',
    ]);
  });

  it('deletes the report even when immediate storage cleanup fails', async () => {
    reportDelegate.findFirst.mockResolvedValue({
      id: report.id,
      assets: [{ storageKey: 'first-key' }, { storageKey: 'failed-key' }],
    });
    reportDelegate.delete.mockResolvedValue(report);
    storageCleanup.attemptMany.mockRejectedValue(new Error('temporary'));

    await expect(service.delete('user-id', report.id)).resolves.toBeUndefined();
    expect(cleanupTaskDelegate.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ storageKey: 'failed-key' }),
        ]),
      }),
    );
    expect(reportDelegate.delete).toHaveBeenCalled();
  });

  it('cannot delete another user’s report', async () => {
    reportDelegate.findFirst.mockResolvedValue(null);

    await expect(
      service.delete('user-id', 'foreign-report-id'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(reportDelegate.delete).not.toHaveBeenCalled();
    expect(cleanupTaskDelegate.createMany).not.toHaveBeenCalled();
  });
});
