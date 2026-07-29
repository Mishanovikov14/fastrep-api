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
        output: { select: { storageKey: true } },
      },
    });
    if (!report?.output) {
      throw notFound('REPORT_OUTPUT_NOT_FOUND', 'Report output not found');
    }
    try {
      return await this.storage.createPresignedDownload(
        report.output.storageKey,
        `${report.title}.pdf`,
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
