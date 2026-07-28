import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, MaxLength } from 'class-validator';

export class ResendRegistrationCodeDto {
  @ApiProperty({
    type: String,
    format: 'email',
    maxLength: 254,
    example: 'user@example.com',
  })
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
