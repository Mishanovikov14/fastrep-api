import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ReportAssetStatus,
  ReportAssetType,
} from '../../../generated/prisma/client';

export class ReportAssetResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  reportId!: string;

  @ApiProperty({ enum: ReportAssetType, enumName: 'ReportAssetType' })
  type!: ReportAssetType;

  @ApiProperty({ enum: ReportAssetStatus, enumName: 'ReportAssetStatus' })
  status!: ReportAssetStatus;

  @ApiProperty({ type: String })
  originalFileName!: string;

  @ApiProperty({ type: String })
  declaredMimeType!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  verifiedMimeType!: string | null;

  @ApiProperty({ type: Number })
  declaredSize!: number;

  @ApiPropertyOptional({ type: Number, nullable: true })
  verifiedSize!: number | null;

  @ApiProperty({ type: Number })
  position!: number;

  @ApiPropertyOptional({ type: Number, nullable: true })
  width!: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  height!: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  durationSeconds!: number | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  rejectionReason!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}
