import { Transform, TransformFnParams } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export enum SupportedLanguage {
  EN = 'en',
  UK = 'uk',
  RU = 'ru',
}

export class RegisterDto {
  @ApiProperty({
    type: String,
    minLength: 2,
    maxLength: 100,
    example: 'Mykhailo Novikov',
  })
  @Transform(({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  fullName!: string;

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

  @ApiPropertyOptional({
    enum: SupportedLanguage,
    default: SupportedLanguage.EN,
    example: SupportedLanguage.UK,
  })
  @Transform(({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @IsEnum(SupportedLanguage)
  language?: SupportedLanguage;
}
