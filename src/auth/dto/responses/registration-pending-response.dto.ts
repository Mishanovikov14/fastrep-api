import { ApiProperty } from '@nestjs/swagger';

export class RegistrationPendingResponseDto {
  @ApiProperty({
    type: String,
    format: 'email',
    example: 'user@example.com',
  })
  email!: string;

  @ApiProperty({ type: Boolean, example: true })
  verificationRequired!: true;

  @ApiProperty({ type: Number, minimum: 60, example: 60 })
  resendAvailableInSeconds!: number;
}
