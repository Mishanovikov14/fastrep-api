/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { NotFoundException } from '@nestjs/common';
import { Report, ReportStatus } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageCleanupService } from '../storage/storage-cleanup.service';
import { ReportsService } from './reports.service';

const createReport = (overrides: Partial<Report> = {}): Report => ({
  id: 'report-id',
  userId: 'user-id',
  title: 'Site inspection',
  notes: 'Inspect the roof.',
  status: ReportStatus.DRAFT,
  createdAt: new Date('2026-07-27T10:00:00.000Z'),
  updatedAt: new Date('2026-07-27T10:00:00.000Z'),
  ...overrides,
});

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
    service = new ReportsService(
      prisma,
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
        status: ReportStatus.DRAFT,
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
      select: { id: true },
    });
  });

  it('returns a failed report to DRAFT when it is edited', async () => {
    reportDelegate.updateMany.mockResolvedValue({ count: 1 });
    reportDelegate.findFirst.mockResolvedValue(
      createReport({ status: ReportStatus.DRAFT }),
    );

    await service.update('user-id', report.id, { notes: 'Corrected notes' });

    expect(reportDelegate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          notes: 'Corrected notes',
          status: ReportStatus.DRAFT,
        },
      }),
    );
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
