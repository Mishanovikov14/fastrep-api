import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { normalizeEmail } from '../common/utils/normalize-email';
import { PrismaService } from '../prisma/prisma.service';
import { PublicUser } from '../users/user-select';
import { UsersService } from '../users/users.service';
import {
  AuthenticationResult,
  RefreshTokenPayload,
  TokenPair,
} from './auth.types';
import { JWT_AUDIENCE, JWT_ISSUER } from './auth.constants';
import { LoginDto } from './dto/login.dto';
import { RegisterDto, SupportedLanguage } from './dto/register.dto';

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
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
}
