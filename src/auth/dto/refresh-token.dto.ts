import { ApiProperty } from '@nestjs/swagger';
import { IsJWT, IsString } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({
    type: String,
    format: 'JWT',
    description: 'Refresh token returned by register, login, or refresh.',
    example: 'header.payload.signature',
  })
  @IsString()
  @IsJWT()
  refreshToken!: string;
}
