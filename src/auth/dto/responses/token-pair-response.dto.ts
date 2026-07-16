import { ApiProperty } from '@nestjs/swagger';

export class TokenPairResponseDto {
  @ApiProperty({
    type: String,
    format: 'JWT',
    description: 'Short-lived JWT used as a Bearer access token.',
    example: 'header.payload.signature',
  })
  accessToken!: string;

  @ApiProperty({
    type: String,
    format: 'JWT',
    description: 'Refresh JWT used to rotate the token pair.',
    example: 'header.payload.signature',
  })
  refreshToken!: string;
}
