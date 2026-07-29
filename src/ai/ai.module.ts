import { Module } from '@nestjs/common';
import { AI_PROVIDER } from './ai-provider.interface';
import { OpenAiClientService } from './openai/openai-client.service';
import { OpenAiReportProviderService } from './openai/openai-report-provider.service';

@Module({
  providers: [
    OpenAiClientService,
    OpenAiReportProviderService,
    {
      provide: AI_PROVIDER,
      useExisting: OpenAiReportProviderService,
    },
  ],
  exports: [AI_PROVIDER],
})
export class AiModule {}
