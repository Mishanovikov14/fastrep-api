import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReportAssetType } from '../../generated/prisma/client';

@Injectable()
export class ReportAssetLimitsService {
  constructor(private readonly config: ConfigService) {}

  maximumBytes(type: ReportAssetType): number {
    return this.number(this.bytesKey(type));
  }

  maximumCount(type: ReportAssetType): number {
    return this.number(this.countKey(type));
  }

  maximumReportBytes(): number {
    return this.number('REPORT_MAX_TOTAL_ASSET_BYTES');
  }

  maximumImageWidth(): number {
    return this.number('IMAGE_MAX_WIDTH');
  }

  maximumImageHeight(): number {
    return this.number('IMAGE_MAX_HEIGHT');
  }

  maximumAudioDurationSeconds(): number {
    return this.number('AUDIO_MAX_DURATION_SECONDS');
  }

  pendingUploadTtlMinutes(): number {
    return this.number('PENDING_UPLOAD_TTL_MINUTES');
  }

  private bytesKey(type: ReportAssetType): string {
    switch (type) {
      case ReportAssetType.IMAGE:
        return 'IMAGE_MAX_BYTES';
      case ReportAssetType.AUDIO:
        return 'AUDIO_MAX_BYTES';
      case ReportAssetType.DOCUMENT:
        return 'DOCUMENT_MAX_BYTES';
    }
  }

  private countKey(type: ReportAssetType): string {
    switch (type) {
      case ReportAssetType.IMAGE:
        return 'REPORT_MAX_IMAGES';
      case ReportAssetType.AUDIO:
        return 'REPORT_MAX_AUDIO_FILES';
      case ReportAssetType.DOCUMENT:
        return 'REPORT_MAX_DOCUMENTS';
    }
  }

  private number(key: string): number {
    const value = Number(this.config.get<string>(key));

    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${key} is not configured`);
    }

    return value;
  }
}
