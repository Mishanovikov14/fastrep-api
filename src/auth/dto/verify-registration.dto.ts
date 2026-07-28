import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Matches, MaxLength } from 'class-validator';

export class VerifyRegistrationDto {
  @ApiProperty({
    type: String,
    format: 'email',
    maxLength: 254,
    example: 'user@example.com',
  })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({
    type: String,
    pattern: '^\\d{6}$',
    example: '123456',
    description: 'Six-digit registration verification code sent by email.',
  })
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}
