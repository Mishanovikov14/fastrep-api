import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [JwtModule.register({}), PrismaModule, StorageModule],
  controllers: [ReportsController],
  providers: [ReportsService, AccessTokenGuard],
})
export class ReportsModule {}
