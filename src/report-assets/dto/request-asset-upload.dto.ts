import { Transform, TransformFnParams } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { ReportAssetType } from '../../../generated/prisma/client';

const trimString = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class RequestAssetUploadDto {
  @ApiProperty({ enum: ReportAssetType, enumName: 'ReportAssetType' })
  @IsEnum(ReportAssetType)
  type!: ReportAssetType;

  @ApiProperty({ type: String, maxLength: 255, example: 'photo.jpg' })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName!: string;

  @ApiProperty({ type: String, maxLength: 127, example: 'image/jpeg' })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(127)
  mimeType!: string;

  @ApiProperty({ type: Number, minimum: 1, example: 3456789 })
  @IsInt()
  @Min(1)
  size!: number;
}
