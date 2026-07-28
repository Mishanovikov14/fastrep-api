import { ApiProperty } from '@nestjs/swagger';

export class RegistrationCooldownResponseDto {
  @ApiProperty({ type: Number, example: 429 })
  statusCode!: number;

  @ApiProperty({
    type: String,
    example: 'Please wait before requesting another registration code',
  })
  message!: string;

  @ApiProperty({ type: String, example: 'Too Many Requests' })
  error!: string;

  @ApiProperty({
    type: String,
    example: 'REGISTRATION_CODE_COOLDOWN',
  })
  code!: 'REGISTRATION_CODE_COOLDOWN';

  @ApiProperty({ type: Number, minimum: 1, example: 42 })
  retryAfterSeconds!: number;
}
