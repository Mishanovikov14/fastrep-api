import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ResetPasswordDto {
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
    description: 'Six-digit password-reset code sent by email.',
  })
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;

  @ApiProperty({
    type: String,
    minLength: 8,
    maxLength: 128,
    example: 'new-secure-password',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword!: string;
}
