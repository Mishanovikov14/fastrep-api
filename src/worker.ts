import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  process.env.FASTREP_PROCESS_ROLE = 'worker';
  const context = await NestFactory.createApplicationContext(WorkerModule);
  context.enableShutdownHooks();
  Logger.log('Report generation worker started', 'WorkerBootstrap');
}

void bootstrap();
