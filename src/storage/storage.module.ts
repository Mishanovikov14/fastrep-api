import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ObjectStorageService } from './object-storage.service';
import { StorageCleanupService } from './storage-cleanup.service';

@Module({
  imports: [PrismaModule],
  providers: [ObjectStorageService, StorageCleanupService],
  exports: [ObjectStorageService, StorageCleanupService],
})
export class StorageModule {}
