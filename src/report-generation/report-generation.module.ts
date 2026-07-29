import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { ReportGenerationsController } from './report-generations.controller';
import { ReportGenerationQueueService } from './report-generation-queue.service';
import { ReportGenerationsService } from './report-generations.service';
import { ReportOutputsController } from './report-outputs.controller';
import { ReportOutputsService } from './report-outputs.service';

@Module({
  imports: [
    JwtModule.register({}),
    PrismaModule,
    StorageModule,
    EntitlementsModule,
  ],
  controllers: [ReportGenerationsController, ReportOutputsController],
  providers: [
    AccessTokenGuard,
    ReportGenerationQueueService,
    ReportGenerationsService,
    ReportOutputsService,
  ],
  exports: [ReportGenerationQueueService],
})
export class ReportGenerationModule {}
