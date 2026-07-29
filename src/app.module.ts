import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from './config/environment';
import { AuthModule } from './auth/auth.module';
import { ReportsModule } from './reports/reports.module';
import { ReportAssetsModule } from './report-assets/report-assets.module';

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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
