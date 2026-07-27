import { ApiProperty } from '@nestjs/swagger';
import { ReportResponseDto } from './report-response.dto';

export class PaginatedReportsDto {
  @ApiProperty({ type: [ReportResponseDto] })
  data!: ReportResponseDto[];

  @ApiProperty({ type: Number, example: 1 })
  page!: number;

  @ApiProperty({ type: Number, example: 20 })
  limit!: number;

  @ApiProperty({ type: Number, example: 42 })
  total!: number;

  @ApiProperty({ type: Number, example: 3 })
  totalPages!: number;
}
