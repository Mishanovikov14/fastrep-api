import { ApiProperty } from '@nestjs/swagger';

class PresignedPostContractDto {
  @ApiProperty({ enum: ['POST'], example: 'POST' })
  method!: 'POST';

  @ApiProperty({ type: String, format: 'uri' })
  url!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      'Form fields that must be submitted unchanged with the object body.',
  })
  fields!: Record<string, string>;
}

export class UploadRequestResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  assetId!: string;

  @ApiProperty({ type: PresignedPostContractDto })
  upload!: PresignedPostContractDto;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: Date;
}
