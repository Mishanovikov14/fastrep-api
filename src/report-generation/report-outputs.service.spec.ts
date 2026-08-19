import { ReportOutputType, ReportStatus } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService } from '../storage/object-storage.service';
import {
  reportDownloadFileName,
  ReportOutputsService,
} from './report-outputs.service';

describe('ReportOutputsService', () => {
  it('creates a sanitized human-friendly filename without a UUID', () => {
    const fileName = reportDownloadFileName(
      'Solar / Installation: Report?',
      new Date('2026-08-19T19:32:16.876Z'),
    );

    expect(fileName).toBe('Solar_Installation_Report_2026-08-19.pdf');
    expect(fileName).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
    );
  });

  it('uses the report title and output date for the download filename', async () => {
    const createdAt = new Date('2026-08-19T19:32:16.876Z');
    const prisma = {
      report: {
        findFirst: jest.fn().mockResolvedValue({
          title: 'Inspection Report',
          output: { storageKey: 'private-key', createdAt },
        }),
      },
    } as unknown as PrismaService;
    const storage = {
      createPresignedDownload: jest.fn().mockResolvedValue({
        url: 'https://download.example',
        expiresAt: createdAt,
      }),
    } as unknown as ObjectStorageService;
    const service = new ReportOutputsService(prisma, storage);

    await service.createDownloadUrl('user-id', 'report-id');

    expect(storage.createPresignedDownload).toHaveBeenCalledWith(
      'private-key',
      'Inspection_Report_2026-08-19.pdf',
    );
  });

  it('returns metadata without a private storage key', async () => {
    const output = {
      id: 'output-id',
      generationId: 'generation-id',
      type: ReportOutputType.PDF,
      mimeType: 'application/pdf',
      size: 1234,
      createdAt: new Date('2026-07-29T12:00:00.000Z'),
    };
    const findFirst = jest.fn().mockResolvedValue({ output });
    const prisma = {
      report: {
        findFirst,
      },
    } as unknown as PrismaService;
    const service = new ReportOutputsService(
      prisma,
      {} as ObjectStorageService,
    );

    await expect(service.getMetadata('user-id', 'report-id')).resolves.toEqual(
      output,
    );
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: 'report-id',
        userId: 'user-id',
        status: ReportStatus.READY,
      },
      select: {
        output: {
          select: {
            id: true,
            generationId: true,
            type: true,
            mimeType: true,
            size: true,
            createdAt: true,
          },
        },
      },
    });
    expect(output).not.toHaveProperty('storageKey');
  });

  it('does not disclose a foreign or non-ready output', async () => {
    const prisma = {
      report: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    } as unknown as PrismaService;
    const service = new ReportOutputsService(
      prisma,
      {} as ObjectStorageService,
    );

    await expect(
      service.getMetadata('user-id', 'foreign-report'),
    ).rejects.toMatchObject({
      response: { code: 'REPORT_OUTPUT_NOT_FOUND' },
    });
  });
});
