import { Injectable, Logger } from '@nestjs/common';
import { ReportStatus } from '../../generated/prisma/client';
import { notFound, unavailable } from '../common/errors/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService } from '../storage/object-storage.service';

const outputSelect = {
  id: true,
  generationId: true,
  type: true,
  mimeType: true,
  size: true,
  createdAt: true,
} as const;

export const reportDownloadFileName = (
  reportTitle: string,
  generatedAt: Date,
): string => {
  const normalizedTitle = reportTitle
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  const safeTitle = Array.from(normalizedTitle)
    .slice(0, 72)
    .join('')
    .replace(/_+$/g, '');
  const date = generatedAt.toISOString().slice(0, 10);
  return `${safeTitle || 'FastRep_Report'}_${date}.pdf`;
};

@Injectable()
export class ReportOutputsService {
  private readonly logger = new Logger(ReportOutputsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService,
  ) {}

  async getMetadata(userId: string, reportId: string) {
    const report = await this.prisma.report.findFirst({
      where: { id: reportId, userId, status: ReportStatus.READY },
      select: { output: { select: outputSelect } },
    });
    if (!report?.output) {
      throw notFound('REPORT_OUTPUT_NOT_FOUND', 'Report output not found');
    }
    return report.output;
  }

  async createDownloadUrl(userId: string, reportId: string) {
    const report = await this.prisma.report.findFirst({
      where: { id: reportId, userId, status: ReportStatus.READY },
      select: {
        title: true,
        output: { select: { storageKey: true, createdAt: true } },
      },
    });
    if (!report?.output) {
      throw notFound('REPORT_OUTPUT_NOT_FOUND', 'Report output not found');
    }
    try {
      return await this.storage.createPresignedDownload(
        report.output.storageKey,
        reportDownloadFileName(report.title, report.output.createdAt),
      );
    } catch {
      this.logger.error({
        event: 'report_output_download_url_failed',
        reportId,
        errorCode: 'OUTPUT_STORAGE_UNAVAILABLE',
      });
      throw unavailable(
        'OUTPUT_STORAGE_UNAVAILABLE',
        'Report download is temporarily unavailable',
      );
    }
  }
}
