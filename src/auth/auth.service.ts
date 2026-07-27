import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { randomInt, randomUUID } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { SupportedLanguage } from '../common/enums/supported-language.enum';
import { normalizeEmail } from '../common/utils/normalize-email';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { PublicUser } from '../users/user-select';
import { UsersService } from '../users/users.service';
import {
  AuthenticationResult,
  RefreshTokenPayload,
  TokenPair,
} from './auth.types';
import { JWT_AUDIENCE, JWT_ISSUER } from './auth.constants';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_PASSWORD_RESET_CODE_TTL_MINUTES = 15;
const DEFAULT_PASSWORD_RESET_MAX_ATTEMPTS = 5;
const DEFAULT_PASSWORD_RESET_RESEND_COOLDOWN_SECONDS = 60;
const INVALID_RESET_CODE_MESSAGE = 'Invalid or expired password reset code';
const TOO_MANY_REQUESTS_STATUS: number = HttpStatus.TOO_MANY_REQUESTS;

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthenticationResult> {
    const email = normalizeEmail(dto.email);
    const existingUser = await this.usersService.findByEmail(email);

    if (existingUser) {
      throw new ConflictException('A user with this email already exists');
    }

    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
    });
    const user = await this.usersService.create({
      fullName: dto.fullName,
      email,
      passwordHash,
      language: dto.language ?? SupportedLanguage.EN,
    });
    const tokens = await this.createTokenPair(user.id);

    return { user, ...tokens };
  }

  async login(dto: LoginDto): Promise<AuthenticationResult> {
    const user = await this.usersService.findByEmail(normalizeEmail(dto.email));
    const passwordIsValid = user
      ? await this.verifyHash(user.passwordHash, dto.password)
      : false;

    if (!user || !passwordIsValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const publicUser = await this.getUser(user.id);
    const tokens = await this.createTokenPair(user.id);

    return { user: publicUser, ...tokens };
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const payload = await this.verifyRefreshToken(refreshToken);
    const storedToken = await this.prisma.refreshToken.findUnique({
      where: { id: payload.jti },
    });

    if (
      !storedToken ||
      storedToken.userId !== payload.sub ||
      storedToken.expiresAt <= new Date() ||
      !(await this.verifyHash(storedToken.tokenHash, refreshToken))
    ) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const nextTokenId = randomUUID();
    const tokens = await this.signTokenPair(payload.sub, nextTokenId);
    const nextTokenHash = await this.hashRefreshToken(tokens.refreshToken);

    await this.prisma.$transaction(async (transaction) => {
      const deleted = await transaction.refreshToken.deleteMany({
        where: { id: storedToken.id, userId: payload.sub },
      });

      if (deleted.count !== 1) {
        throw new UnauthorizedException('Refresh token has already been used');
      }

      await transaction.refreshToken.create({
        data: {
          id: nextTokenId,
          userId: payload.sub,
          tokenHash: nextTokenHash,
          expiresAt: this.getRefreshExpiration(),
        },
      });
    });

    return tokens;
  }

  async logout(refreshToken: string): Promise<void> {
    const payload = await this.verifyRefreshToken(refreshToken);
    const storedToken = await this.prisma.refreshToken.findUnique({
      where: { id: payload.jti },
    });

    if (!storedToken) {
      return;
    }

    if (
      storedToken.userId !== payload.sub ||
      !(await this.verifyHash(storedToken.tokenHash, refreshToken))
    ) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    await this.prisma.refreshToken.deleteMany({
      where: { id: storedToken.id, userId: payload.sub },
    });
  }

  async forgotPassword(dto: ForgotPasswordDto): Promise<void> {
    const email = normalizeEmail(dto.email);
    const user = await this.usersService.findByEmail(email);

    if (!user) {
      return;
    }

    const now = new Date();
    const ttlMinutes = this.getPositiveInteger(
      'PASSWORD_RESET_CODE_TTL_MINUTES',
      DEFAULT_PASSWORD_RESET_CODE_TTL_MINUTES,
    );
    const cooldownSeconds = this.getPositiveInteger(
      'PASSWORD_RESET_RESEND_COOLDOWN_SECONDS',
      DEFAULT_PASSWORD_RESET_RESEND_COOLDOWN_SECONDS,
    );
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const codeHash = await argon2.hash(code, { type: argon2.argon2id });

    let requestId: string;

    try {
      const request = await this.prisma.$transaction(async (transaction) => {
        const latestRequest = await transaction.passwordResetRequest.findFirst({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' },
        });
        const cooldownStartedAt = new Date(
          now.getTime() - cooldownSeconds * 1000,
        );

        if (
          latestRequest &&
          latestRequest.createdAt.getTime() > cooldownStartedAt.getTime()
        ) {
          throw new HttpException(
            'Please wait before requesting another code',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }

        await transaction.passwordResetRequest.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: now },
        });

        return transaction.passwordResetRequest.create({
          data: {
            userId: user.id,
            codeHash,
            expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
          },
        });
      });
      requestId = request.id;
    } catch (error) {
      if (
        error instanceof HttpException &&
        error.getStatus() === TOO_MANY_REQUESTS_STATUS
      ) {
        throw error;
      }

      if (this.isPasswordResetWriteConflict(error)) {
        throw new HttpException(
          'Please wait before requesting another code',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      throw new ServiceUnavailableException(
        'Password reset is temporarily unavailable',
      );
    }

    try {
      await this.mailService.sendPasswordResetCode(email, code, ttlMinutes);
    } catch {
      await this.prisma.passwordResetRequest.updateMany({
        where: { id: requestId, usedAt: null },
        data: { usedAt: new Date() },
      });
      throw new ServiceUnavailableException(
        'Password reset is temporarily unavailable',
      );
    }
  }

  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const email = normalizeEmail(dto.email);
    const user = await this.usersService.findByEmail(email);

    if (!user) {
      throw new BadRequestException(INVALID_RESET_CODE_MESSAGE);
    }

    const request = await this.prisma.passwordResetRequest.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    const maxAttempts = this.getPositiveInteger(
      'PASSWORD_RESET_MAX_ATTEMPTS',
      DEFAULT_PASSWORD_RESET_MAX_ATTEMPTS,
    );
    const now = new Date();

    if (
      !request ||
      request.usedAt ||
      request.expiresAt <= now ||
      request.attemptCount >= maxAttempts
    ) {
      throw new BadRequestException(INVALID_RESET_CODE_MESSAGE);
    }

    const codeIsValid = await this.verifyHash(request.codeHash, dto.code);

    if (!codeIsValid) {
      await this.recordFailedResetAttempt(
        request.id,
        request.attemptCount,
        maxAttempts,
        now,
      );
      throw new BadRequestException(INVALID_RESET_CODE_MESSAGE);
    }

    const passwordHash = await argon2.hash(dto.newPassword, {
      type: argon2.argon2id,
    });

    await this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.passwordResetRequest.updateMany({
        where: {
          id: request.id,
          userId: user.id,
          usedAt: null,
          expiresAt: { gt: now },
          attemptCount: { lt: maxAttempts },
        },
        data: { usedAt: now },
      });

      if (claimed.count !== 1) {
        throw new BadRequestException(INVALID_RESET_CODE_MESSAGE);
      }

      await transaction.user.update({
        where: { id: user.id },
        data: { passwordHash },
      });
      await transaction.passwordResetRequest.updateMany({
        where: {
          userId: user.id,
          id: { not: request.id },
          usedAt: null,
        },
        data: { usedAt: now },
      });
      await transaction.refreshToken.deleteMany({
        where: { userId: user.id },
      });
    });
  }

  getMe(userId: string): Promise<PublicUser> {
    return this.getUser(userId);
  }

  private async createTokenPair(userId: string): Promise<TokenPair> {
    const tokenId = randomUUID();
    const tokens = await this.signTokenPair(userId, tokenId);
    const tokenHash = await this.hashRefreshToken(tokens.refreshToken);

    await this.prisma.refreshToken.create({
      data: {
        id: tokenId,
        userId,
        tokenHash,
        expiresAt: this.getRefreshExpiration(),
      },
    });

    return tokens;
  }

  private async signTokenPair(
    userId: string,
    refreshTokenId: string,
  ): Promise<TokenPair> {
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(
        { sub: userId, type: 'access' },
        {
          secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
          expiresIn: ACCESS_TOKEN_TTL_SECONDS,
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
        },
      ),
      this.jwtService.signAsync(
        { sub: userId, jti: refreshTokenId, type: 'refresh' },
        {
          secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
          expiresIn: REFRESH_TOKEN_TTL_SECONDS,
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
        },
      ),
    ]);

    return { accessToken, refreshToken };
  }

  private async verifyRefreshToken(
    refreshToken: string,
  ): Promise<RefreshTokenPayload> {
    try {
      const payload = await this.jwtService.verifyAsync<RefreshTokenPayload>(
        refreshToken,
        {
          secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
        },
      );

      if (
        payload.type !== 'refresh' ||
        typeof payload.sub !== 'string' ||
        typeof payload.jti !== 'string'
      ) {
        throw new Error('Invalid refresh token payload');
      }

      return payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  private async getUser(userId: string): Promise<PublicUser> {
    const user = await this.usersService.findById(userId);

    if (!user) {
      throw new UnauthorizedException('Invalid session');
    }

    return user;
  }

  private hashRefreshToken(refreshToken: string): Promise<string> {
    return argon2.hash(refreshToken, { type: argon2.argon2id });
  }

  private async verifyHash(hash: string, value: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, value);
    } catch {
      return false;
    }
  }

  private getRefreshExpiration(): Date {
    return new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
  }

  private async recordFailedResetAttempt(
    requestId: string,
    attemptCount: number,
    maxAttempts: number,
    attemptedAt: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.passwordResetRequest.updateMany({
        where: {
          id: requestId,
          usedAt: null,
          expiresAt: { gt: attemptedAt },
          attemptCount,
        },
        data: { attemptCount: { increment: 1 } },
      });

      if (updated.count === 1 && attemptCount + 1 >= maxAttempts) {
        await transaction.passwordResetRequest.updateMany({
          where: {
            id: requestId,
            usedAt: null,
            attemptCount: { gte: maxAttempts },
          },
          data: { usedAt: attemptedAt },
        });
      }
    });
  }

  private getPositiveInteger(key: string, fallback: number): number {
    const configured = this.configService.get<string | number>(key);
    const value = Number(configured ?? fallback);

    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private isPasswordResetWriteConflict(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      ['P2002', 'P2034'].includes(error.code)
    );
  }
}
