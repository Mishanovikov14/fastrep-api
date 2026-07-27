import { NotFoundException } from '@nestjs/common';
import { Report, ReportStatus } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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
    };
    const prisma = {
      report: reportDelegate,
      $transaction: jest.fn((operations: Promise<unknown>[]) =>
        Promise.all(operations),
      ),
    } as unknown as PrismaService;

    service = new ReportsService(prisma);
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
      status: ReportStatus.READY,
    });
    reportDelegate.updateMany.mockResolvedValue({ count: 1 });
    reportDelegate.findFirst.mockResolvedValue(updatedReport);

    await expect(
      service.update('user-id', report.id, {
        title: updatedReport.title,
        status: ReportStatus.READY,
      }),
    ).resolves.toEqual(updatedReport);
    expect(reportDelegate.updateMany).toHaveBeenCalledWith({
      where: { id: report.id, userId: 'user-id' },
      data: {
        title: updatedReport.title,
        status: ReportStatus.READY,
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
    expect(reportDelegate.findFirst).not.toHaveBeenCalled();
  });

  it('deletes an owned report', async () => {
    reportDelegate.deleteMany.mockResolvedValue({ count: 1 });

    await expect(service.delete('user-id', report.id)).resolves.toBeUndefined();
    expect(reportDelegate.deleteMany).toHaveBeenCalledWith({
      where: { id: report.id, userId: 'user-id' },
    });
  });

  it('cannot delete another user’s report', async () => {
    reportDelegate.deleteMany.mockResolvedValue({ count: 0 });

    await expect(
      service.delete('user-id', 'foreign-report-id'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
