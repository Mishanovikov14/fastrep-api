import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from './config/environment';
import { AuthModule } from './auth/auth.module';
import { ReportsModule } from './reports/reports.module';
import { ReportAssetsModule } from './report-assets/report-assets.module';
import { EntitlementsModule } from './entitlements/entitlements.module';
import { ReportGenerationModule } from './report-generation/report-generation.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
    }),
    PrismaModule,
    AuthModule,
    ReportsModule,
    ReportAssetsModule,
    EntitlementsModule,
    ReportGenerationModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
