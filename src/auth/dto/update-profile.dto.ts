import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsTimeZone } from 'class-validator';

export class UpdateProfileDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Europe/Kyiv',
    description: 'IANA timezone used for user-facing report timestamps.',
  })
  @IsOptional()
  @IsTimeZone()
  timezone?: string | null;
}
