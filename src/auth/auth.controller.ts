import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AccessTokenGuard } from './access-token.guard';
import { AuthService } from './auth.service';
import { CurrentUserId } from './current-user-id.decorator';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { AuthenticationResponseDto } from './dto/responses/authentication-response.dto';
import { PublicUserResponseDto } from './dto/responses/public-user-response.dto';
import { TokenPairResponseDto } from './dto/responses/token-pair-response.dto';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @ApiOperation({ summary: 'Register a new user' })
  @ApiCreatedResponse({
    description: 'User registered successfully.',
    type: AuthenticationResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid registration data.' })
  @ApiConflictResponse({ description: 'Email already exists.' })
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @ApiOperation({ summary: 'Log in with email and password' })
  @ApiOkResponse({
    description: 'User authenticated successfully.',
    type: AuthenticationResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid login data.' })
  @ApiUnauthorizedResponse({ description: 'Invalid email or password.' })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @ApiOperation({ summary: 'Rotate a refresh token' })
  @ApiOkResponse({
    description: 'Token pair rotated successfully.',
    type: TokenPairResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid refresh request data.' })
  @ApiUnauthorizedResponse({
    description: 'Invalid, expired, or reused refresh token.',
  })
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @ApiOperation({ summary: 'Log out using a refresh token' })
  @ApiNoContentResponse({ description: 'Logged out successfully.' })
  @ApiBadRequestResponse({ description: 'Invalid logout request data.' })
  @ApiUnauthorizedResponse({ description: 'Invalid refresh token.' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout')
  logout(@Body() dto: RefreshTokenDto) {
    return this.authService.logout(dto.refreshToken);
  }

  @ApiOperation({ summary: 'Get the current authenticated user' })
  @ApiBearerAuth('access-token')
  @ApiOkResponse({
    description: 'Current user returned successfully.',
    type: PublicUserResponseDto,
  })
  @ApiUnauthorizedResponse({
    description:
      'Missing, invalid, or expired access token, or invalid session.',
  })
  @UseGuards(AccessTokenGuard)
  @Get('me')
  me(@CurrentUserId() userId: string) {
    return this.authService.getMe(userId);
  }
}
