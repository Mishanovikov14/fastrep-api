import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiModule } from './ai/ai.module';
import { validateEnvironment } from './config/environment';
import { EntitlementsModule } from './entitlements/entitlements.module';
import { PrismaModule } from './prisma/prisma.module';
import { AssetTranscriptionsService } from './report-generation/asset-transcriptions.service';
import { PdfReportService } from './report-generation/pdf-report.service';
import { ProviderAttemptsService } from './report-generation/provider-attempts.service';
import { ReportGenerationProcessorService } from './report-generation/report-generation-processor.service';
import { ReportGenerationWorkerService } from './report-generation/report-generation-worker.service';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
    }),
    PrismaModule,
    StorageModule,
    EntitlementsModule,
    AiModule,
  ],
  providers: [
    AssetTranscriptionsService,
    PdfReportService,
    ProviderAttemptsService,
    ReportGenerationProcessorService,
    ReportGenerationWorkerService,
  ],
})
export class WorkerModule {}
