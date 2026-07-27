import { Transform, TransformFnParams } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

const trimString = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateReportDto {
  @ApiProperty({
    type: String,
    maxLength: 120,
    example: 'Site inspection',
  })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title!: string;

  @ApiPropertyOptional({
    type: String,
    maxLength: 50000,
    example: 'Document the roof condition and exterior damage.',
  })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(50000)
  notes?: string;
}
