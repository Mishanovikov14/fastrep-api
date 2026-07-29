import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { ReportAssetLimitsService } from './report-asset-limits.service';
import { ReportAssetsController } from './report-assets.controller';
import { ReportAssetsService } from './report-assets.service';

@Module({
  imports: [
    JwtModule.register({}),
    ThrottlerModule.forRoot([
      {
        name: 'assetUpload',
        ttl: 60_000,
        limit: 20,
      },
    ]),
    PrismaModule,
    StorageModule,
  ],
  controllers: [ReportAssetsController],
  providers: [ReportAssetsService, ReportAssetLimitsService, AccessTokenGuard],
  exports: [ReportAssetsService],
})
export class ReportAssetsModule {}
