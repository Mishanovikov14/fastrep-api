import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { MailModule } from '../mail/mail.module';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { AccessTokenGuard } from './access-token.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  imports: [
    JwtModule.register({}),
    ThrottlerModule.forRoot([
      {
        name: 'passwordRecovery',
        ttl: 60_000,
        limit: 10,
      },
    ]),
    MailModule,
    PrismaModule,
    UsersModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, AccessTokenGuard],
})
export class AuthModule {}
