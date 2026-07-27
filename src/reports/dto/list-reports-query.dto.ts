import { Transform, TransformFnParams } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

const toNumber = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' && value.trim() !== '' ? Number(value) : value;

export class ListReportsQueryDto {
  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    default: 1,
    example: 1,
  })
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    maximum: 100,
    default: 20,
    example: 20,
  })
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}
