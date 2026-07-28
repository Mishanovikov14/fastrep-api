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
import { PublicUser, publicUserSelect } from '../users/user-select';
import { UsersService } from '../users/users.service';
import {
  AuthenticationResult,
  RefreshTokenPayload,
  RegistrationPendingResult,
  TokenPair,
} from './auth.types';
import { JWT_AUDIENCE, JWT_ISSUER } from './auth.constants';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResendRegistrationCodeDto } from './dto/resend-registration-code.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyRegistrationDto } from './dto/verify-registration.dto';

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_PASSWORD_RESET_CODE_TTL_MINUTES = 15;
const DEFAULT_PASSWORD_RESET_MAX_ATTEMPTS = 5;
const DEFAULT_PASSWORD_RESET_RESEND_COOLDOWN_SECONDS = 60;
const DEFAULT_REGISTRATION_CODE_TTL_MINUTES = 15;
const DEFAULT_REGISTRATION_MAX_ATTEMPTS = 5;
const DEFAULT_REGISTRATION_RESEND_COOLDOWN_SECONDS = 60;
const DEFAULT_PENDING_REGISTRATION_TTL_HOURS = 24;
const INVALID_RESET_CODE_MESSAGE = 'Invalid or expired password reset code';
const INVALID_REGISTRATION_CODE_MESSAGE =
  'Invalid or expired registration verification code';
const REGISTRATION_COOLDOWN_CODE = 'REGISTRATION_CODE_COOLDOWN';
const TOO_MANY_REQUESTS_STATUS: number = HttpStatus.TOO_MANY_REQUESTS;

type RegistrationPolicy = {
  codeTtlMinutes: number;
  maxAttempts: number;
  resendCooldownSeconds: number;
  pendingTtlHours: number;
};

type PreparedTokenPair = {
  tokens: TokenPair;
  tokenId: string;
  tokenHash: string;
  expiresAt: Date;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
  ) {}

  async register(dto: RegisterDto): Promise<RegistrationPendingResult> {
    const email = normalizeEmail(dto.email);
    const existingUser = await this.usersService.findByEmail(email);

    if (existingUser) {
      throw new ConflictException('A user with this email already exists');
    }

    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
    });
    const language = dto.language ?? SupportedLanguage.EN;
    const policy = this.getRegistrationPolicy();
    const now = new Date();
    const code = this.generateSixDigitCode();
    const codeHash = await argon2.hash(code, { type: argon2.argon2id });
    let pendingRegistrationId: string;

    try {
      const pendingRegistration = await this.prisma.$transaction(
        async (transaction) => {
          const permanentUser = await transaction.user.findUnique({
            where: { email },
            select: { id: true },
          });

          if (permanentUser) {
            throw new ConflictException(
              'A user with this email already exists',
            );
          }

          let pending = await transaction.pendingRegistration.findUnique({
            where: { email },
          });

          if (pending && pending.pendingExpiresAt <= now) {
            await transaction.pendingRegistration.deleteMany({
              where: { id: pending.id, pendingExpiresAt: { lte: now } },
            });
            pending = null;
          }

          if (pending) {
            this.enforceRegistrationCooldown(
              pending.lastSentAt,
              now,
              policy.resendCooldownSeconds,
            );

            const updated = await transaction.pendingRegistration.updateMany({
              where: {
                id: pending.id,
                email,
                lastSentAt: pending.lastSentAt,
                pendingExpiresAt: { gt: now },
              },
              data: {
                fullName: dto.fullName,
                passwordHash,
                language,
                codeHash,
                expiresAt: this.addMinutes(now, policy.codeTtlMinutes),
                attemptCount: 0,
                lastSentAt: now,
              },
            });

            if (updated.count !== 1) {
              throw this.registrationCooldownException(
                policy.resendCooldownSeconds,
              );
            }

            return { id: pending.id };
          }

          return transaction.pendingRegistration.create({
            data: {
              email,
              fullName: dto.fullName,
              passwordHash,
              language,
              codeHash,
              expiresAt: this.addMinutes(now, policy.codeTtlMinutes),
              lastSentAt: now,
              pendingExpiresAt: this.addHours(now, policy.pendingTtlHours),
            },
            select: { id: true },
          });
        },
      );
      pendingRegistrationId = pendingRegistration.id;
    } catch (error) {
      if (
        error instanceof ConflictException ||
        (error instanceof HttpException &&
          error.getStatus() === TOO_MANY_REQUESTS_STATUS)
      ) {
        throw error;
      }

      if (this.isRegistrationWriteConflict(error)) {
        if (await this.usersService.findByEmail(email)) {
          throw new ConflictException('A user with this email already exists');
        }

        throw this.registrationCooldownException(policy.resendCooldownSeconds);
      }

      throw new ServiceUnavailableException(
        'Registration is temporarily unavailable',
      );
    }

    try {
      await this.mailService.sendRegistrationVerificationCode(
        email,
        code,
        policy.codeTtlMinutes,
        language,
      );
    } catch {
      await this.invalidatePendingRegistrationCode(
        pendingRegistrationId,
        codeHash,
        policy.maxAttempts,
        new Date(),
      );
      throw new ServiceUnavailableException(
        'Registration email is temporarily unavailable',
      );
    }

    return {
      email,
      verificationRequired: true,
      resendAvailableInSeconds: policy.resendCooldownSeconds,
    };
  }

  async verifyRegistration(
    dto: VerifyRegistrationDto,
  ): Promise<AuthenticationResult> {
    const email = normalizeEmail(dto.email);
    const policy = this.getRegistrationPolicy();
    const now = new Date();
    const pending = await this.prisma.pendingRegistration.findUnique({
      where: { email },
    });

    if (!pending) {
      throw new BadRequestException(INVALID_REGISTRATION_CODE_MESSAGE);
    }

    if (pending.pendingExpiresAt <= now) {
      await this.prisma.pendingRegistration.deleteMany({
        where: { id: pending.id, pendingExpiresAt: { lte: now } },
      });
      throw new BadRequestException(INVALID_REGISTRATION_CODE_MESSAGE);
    }

    if (
      pending.expiresAt <= now ||
      pending.attemptCount >= policy.maxAttempts
    ) {
      throw new BadRequestException(INVALID_REGISTRATION_CODE_MESSAGE);
    }

    const codeIsValid = await this.verifyHash(pending.codeHash, dto.code);

    if (!codeIsValid) {
      await this.recordFailedRegistrationAttempt(
        pending.id,
        pending.codeHash,
        pending.attemptCount,
        policy.maxAttempts,
        now,
      );
      throw new BadRequestException(INVALID_REGISTRATION_CODE_MESSAGE);
    }

    const userId = randomUUID();
    const preparedTokens = await this.prepareTokenPair(userId);

    try {
      const user = await this.prisma.$transaction(async (transaction) => {
        const permanentUser = await transaction.user.findUnique({
          where: { email },
          select: { id: true },
        });

        if (permanentUser) {
          throw new ConflictException('A user with this email already exists');
        }

        const claimed = await transaction.pendingRegistration.deleteMany({
          where: {
            id: pending.id,
            email,
            codeHash: pending.codeHash,
            expiresAt: { gt: now },
            pendingExpiresAt: { gt: now },
            attemptCount: { lt: policy.maxAttempts },
          },
        });

        if (claimed.count !== 1) {
          throw new BadRequestException(INVALID_REGISTRATION_CODE_MESSAGE);
        }

        const createdUser = await transaction.user.create({
          data: {
            id: userId,
            email,
            fullName: pending.fullName,
            passwordHash: pending.passwordHash,
            language: pending.language,
            emailVerifiedAt: now,
          },
          select: publicUserSelect,
        });

        await transaction.refreshToken.create({
          data: {
            id: preparedTokens.tokenId,
            userId,
            tokenHash: preparedTokens.tokenHash,
            expiresAt: preparedTokens.expiresAt,
          },
        });

        return createdUser;
      });

      return { user, ...preparedTokens.tokens };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException
      ) {
        throw error;
      }

      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('A user with this email already exists');
      }

      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034'
      ) {
        throw new BadRequestException(INVALID_REGISTRATION_CODE_MESSAGE);
      }

      throw error;
    }
  }

  async resendRegistrationCode(dto: ResendRegistrationCodeDto): Promise<void> {
    const email = normalizeEmail(dto.email);

    if (await this.usersService.findByEmail(email)) {
      return;
    }

    const policy = this.getRegistrationPolicy();
    const now = new Date();
    const code = this.generateSixDigitCode();
    const codeHash = await argon2.hash(code, { type: argon2.argon2id });
    let pendingRegistration:
      | { shouldSend: false }
      | {
          shouldSend: true;
          id: string;
          language: SupportedLanguage;
        };

    try {
      pendingRegistration = await this.prisma.$transaction(
        async (transaction) => {
          const permanentUser = await transaction.user.findUnique({
            where: { email },
            select: { id: true },
          });

          if (permanentUser) {
            return { shouldSend: false as const };
          }

          const pending = await transaction.pendingRegistration.findUnique({
            where: { email },
          });

          if (!pending) {
            return { shouldSend: false as const };
          }

          if (pending.pendingExpiresAt <= now) {
            await transaction.pendingRegistration.deleteMany({
              where: { id: pending.id, pendingExpiresAt: { lte: now } },
            });
            return { shouldSend: false as const };
          }

          this.enforceRegistrationCooldown(
            pending.lastSentAt,
            now,
            policy.resendCooldownSeconds,
          );

          const updated = await transaction.pendingRegistration.updateMany({
            where: {
              id: pending.id,
              email,
              lastSentAt: pending.lastSentAt,
              pendingExpiresAt: { gt: now },
            },
            data: {
              codeHash,
              expiresAt: this.addMinutes(now, policy.codeTtlMinutes),
              attemptCount: 0,
              lastSentAt: now,
            },
          });

          if (updated.count !== 1) {
            throw this.registrationCooldownException(
              policy.resendCooldownSeconds,
            );
          }

          return {
            shouldSend: true as const,
            id: pending.id,
            language: pending.language as SupportedLanguage,
          };
        },
      );
    } catch (error) {
      if (
        error instanceof HttpException &&
        error.getStatus() === TOO_MANY_REQUESTS_STATUS
      ) {
        throw error;
      }

      if (this.isRegistrationWriteConflict(error)) {
        throw this.registrationCooldownException(policy.resendCooldownSeconds);
      }

      throw new ServiceUnavailableException(
        'Registration is temporarily unavailable',
      );
    }

    if (!pendingRegistration.shouldSend) {
      return;
    }

    try {
      await this.mailService.sendRegistrationVerificationCode(
        email,
        code,
        policy.codeTtlMinutes,
        pendingRegistration.language,
      );
    } catch {
      await this.invalidatePendingRegistrationCode(
        pendingRegistration.id,
        codeHash,
        policy.maxAttempts,
        new Date(),
      );
      throw new ServiceUnavailableException(
        'Registration email is temporarily unavailable',
      );
    }
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
    const prepared = await this.prepareTokenPair(userId);

    await this.prisma.refreshToken.create({
      data: {
        id: prepared.tokenId,
        userId,
        tokenHash: prepared.tokenHash,
        expiresAt: prepared.expiresAt,
      },
    });

    return prepared.tokens;
  }

  private async prepareTokenPair(userId: string): Promise<PreparedTokenPair> {
    const tokenId = randomUUID();
    const tokens = await this.signTokenPair(userId, tokenId);
    const tokenHash = await this.hashRefreshToken(tokens.refreshToken);

    return {
      tokens,
      tokenId,
      tokenHash,
      expiresAt: this.getRefreshExpiration(),
    };
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

  private async recordFailedRegistrationAttempt(
    pendingRegistrationId: string,
    codeHash: string,
    attemptCount: number,
    maxAttempts: number,
    attemptedAt: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.pendingRegistration.updateMany({
        where: {
          id: pendingRegistrationId,
          codeHash,
          expiresAt: { gt: attemptedAt },
          pendingExpiresAt: { gt: attemptedAt },
          attemptCount,
        },
        data: { attemptCount: { increment: 1 } },
      });

      if (updated.count === 1 && attemptCount + 1 >= maxAttempts) {
        await transaction.pendingRegistration.updateMany({
          where: {
            id: pendingRegistrationId,
            codeHash,
            attemptCount: { gte: maxAttempts },
          },
          data: { expiresAt: attemptedAt },
        });
      }
    });
  }

  private invalidatePendingRegistrationCode(
    pendingRegistrationId: string,
    codeHash: string,
    maxAttempts: number,
    invalidatedAt: Date,
  ): Promise<Prisma.BatchPayload> {
    return this.prisma.pendingRegistration.updateMany({
      where: { id: pendingRegistrationId, codeHash },
      data: {
        expiresAt: invalidatedAt,
        attemptCount: maxAttempts,
      },
    });
  }

  private getRegistrationPolicy(): RegistrationPolicy {
    return {
      codeTtlMinutes: this.getPositiveInteger(
        'REGISTRATION_CODE_TTL_MINUTES',
        DEFAULT_REGISTRATION_CODE_TTL_MINUTES,
      ),
      maxAttempts: this.getPositiveInteger(
        'REGISTRATION_MAX_ATTEMPTS',
        DEFAULT_REGISTRATION_MAX_ATTEMPTS,
      ),
      resendCooldownSeconds: this.getPositiveInteger(
        'REGISTRATION_RESEND_COOLDOWN_SECONDS',
        DEFAULT_REGISTRATION_RESEND_COOLDOWN_SECONDS,
      ),
      pendingTtlHours: this.getPositiveInteger(
        'PENDING_REGISTRATION_TTL_HOURS',
        DEFAULT_PENDING_REGISTRATION_TTL_HOURS,
      ),
    };
  }

  private generateSixDigitCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  private enforceRegistrationCooldown(
    lastSentAt: Date,
    now: Date,
    cooldownSeconds: number,
  ): void {
    const retryAfterSeconds = Math.ceil(
      (lastSentAt.getTime() + cooldownSeconds * 1000 - now.getTime()) / 1000,
    );

    if (retryAfterSeconds > 0) {
      throw this.registrationCooldownException(retryAfterSeconds);
    }
  }

  private registrationCooldownException(
    retryAfterSeconds: number,
  ): HttpException {
    return new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: 'Please wait before requesting another registration code',
        error: 'Too Many Requests',
        code: REGISTRATION_COOLDOWN_CODE,
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private addMinutes(date: Date, minutes: number): Date {
    return new Date(date.getTime() + minutes * 60_000);
  }

  private addHours(date: Date, hours: number): Date {
    return new Date(date.getTime() + hours * 60 * 60_000);
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

  private isRegistrationWriteConflict(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      ['P2002', 'P2034'].includes(error.code)
    );
  }
}
