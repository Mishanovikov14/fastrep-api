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
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AccessTokenGuard } from './access-token.guard';
import { AuthService } from './auth.service';
import { CurrentUserId } from './current-user-id.decorator';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
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

  @ApiOperation({
    summary: 'Request a six-digit password-reset code',
    description:
      'Always returns the same response whether or not the account exists. Codes expire after 15 minutes by default.',
  })
  @ApiNoContentResponse({
    description:
      'The request was accepted. Account existence is never disclosed.',
  })
  @ApiBadRequestResponse({ description: 'Invalid email.' })
  @ApiTooManyRequestsResponse({
    description: 'IP rate limit or per-account resend cooldown exceeded.',
  })
  @ApiServiceUnavailableResponse({
    description: 'Email delivery is temporarily unavailable.',
  })
  @Throttle({ passwordRecovery: { limit: 5, ttl: 60_000 } })
  @UseGuards(ThrottlerGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto): Promise<void> {
    return this.authService.forgotPassword(dto);
  }

  @ApiOperation({
    summary: 'Reset a password using the emailed six-digit code',
    description:
      'A successful reset revokes every refresh session and returns no tokens. The user must log in again.',
  })
  @ApiNoContentResponse({
    description: 'Password reset. A new login is required.',
  })
  @ApiBadRequestResponse({
    description:
      'Invalid request data or an invalid, expired, used, or exhausted code.',
  })
  @ApiTooManyRequestsResponse({
    description: 'IP rate limit exceeded.',
  })
  @Throttle({ passwordRecovery: { limit: 10, ttl: 60_000 } })
  @UseGuards(ThrottlerGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    return this.authService.resetPassword(dto);
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
