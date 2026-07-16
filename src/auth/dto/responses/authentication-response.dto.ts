import { ApiProperty } from '@nestjs/swagger';
import { PublicUserResponseDto } from './public-user-response.dto';
import { TokenPairResponseDto } from './token-pair-response.dto';

export class AuthenticationResponseDto extends TokenPairResponseDto {
  @ApiProperty({ type: PublicUserResponseDto })
  user!: PublicUserResponseDto;
}
