import { Transform, TransformFnParams } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ReportStatus } from '../../../generated/prisma/client';

const trimString = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class UpdateReportDto {
  @ApiPropertyOptional({
    type: String,
    maxLength: 120,
    example: 'Updated site inspection',
  })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional({
    type: String,
    maxLength: 50000,
    example: 'Add close-up photos during the next visit.',
  })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(50000)
  notes?: string;

  @ApiPropertyOptional({
    enum: ReportStatus,
    enumName: 'ReportStatus',
    example: ReportStatus.READY,
  })
  @IsOptional()
  @IsEnum(ReportStatus)
  status?: ReportStatus;
}
