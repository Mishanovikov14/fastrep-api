import { ApiProperty } from '@nestjs/swagger';
import { ReportStatus } from '../../../generated/prisma/client';

export class ReportResponseDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    example: '7d92dbb6-239b-4d92-b1dd-af3db9128ba2',
  })
  id!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    example: '8c5ecb58-20d6-41ce-89fb-4d79e84b9cf8',
  })
  userId!: string;

  @ApiProperty({
    type: String,
    maxLength: 120,
    example: 'Site inspection',
  })
  title!: string;

  @ApiProperty({
    type: String,
    maxLength: 50000,
    nullable: true,
    example: 'Document the roof condition and exterior damage.',
  })
  notes!: string | null;

  @ApiProperty({
    enum: ReportStatus,
    enumName: 'ReportStatus',
    example: ReportStatus.DRAFT,
  })
  status!: ReportStatus;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-07-27T10:15:30.000Z',
  })
  createdAt!: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-07-27T10:15:30.000Z',
  })
  updatedAt!: Date;
}
