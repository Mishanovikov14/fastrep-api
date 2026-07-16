import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    type: String,
    format: 'email',
    maxLength: 254,
    example: 'mike@example.com',
  })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({
    type: String,
    minLength: 8,
    maxLength: 128,
    example: 'not-a-real-password',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}
