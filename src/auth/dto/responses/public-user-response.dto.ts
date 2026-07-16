import { ApiProperty } from '@nestjs/swagger';

export class PublicUserResponseDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    example: '8c5ecb58-20d6-41ce-89fb-4d79e84b9cf8',
  })
  id!: string;

  @ApiProperty({ type: String, example: 'Mykhailo Novikov' })
  fullName!: string;

  @ApiProperty({
    type: String,
    format: 'email',
    example: 'mike@example.com',
  })
  email!: string;

  @ApiProperty({
    type: String,
    enum: ['en', 'uk', 'ru'],
    example: 'uk',
  })
  language!: string;

  @ApiProperty({
    type: String,
    format: 'uri',
    nullable: true,
    example: 'https://cdn.example.com/users/profile-photo.jpg',
  })
  photoUrl!: string | null;

  @ApiProperty({ type: Boolean, example: false })
  isPremium!: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-07-16T10:15:30.000Z',
  })
  createdAt!: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-07-16T10:15:30.000Z',
  })
  updatedAt!: Date;
}
