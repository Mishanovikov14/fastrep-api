import { ReportOutputType, ReportStatus } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService } from '../storage/object-storage.service';
import { ReportOutputsService } from './report-outputs.service';

describe('ReportOutputsService', () => {
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
