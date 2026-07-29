import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { CreditsService } from './credits.service';
import { EntitlementsController } from './entitlements.controller';
import { EntitlementsService } from './entitlements.service';

@Module({
  imports: [JwtModule.register({}), PrismaModule],
  controllers: [EntitlementsController],
  providers: [AccessTokenGuard, CreditsService, EntitlementsService],
  exports: [CreditsService],
})
export class EntitlementsModule {}
