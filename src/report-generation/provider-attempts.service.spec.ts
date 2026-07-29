import { ConfigService } from '@nestjs/config';
import {
  GenerationProviderOperation,
  Prisma,
} from '../../generated/prisma/client';
import { AiProviderError } from '../ai/ai-provider.interface';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderAttemptsService } from './provider-attempts.service';

describe('ProviderAttemptsService', () => {
  it('stops before a provider call when its durable budget is exhausted', async () => {
    const delegate = {
      count: jest.fn().mockResolvedValue(2),
      create: jest.fn(),
    };
    const transaction = {
      generationProviderAttempt: delegate,
    } as unknown as Prisma.TransactionClient;
    const prisma = {
      $transaction: jest.fn(
        (callback: (client: Prisma.TransactionClient) => Promise<unknown>) =>
          callback(transaction),
      ),
    } as unknown as PrismaService;
    const config = {
      get: jest.fn(() => '2'),
    } as unknown as ConfigService;
    const service = new ProviderAttemptsService(prisma, config);

    await expect(
      service.start(
        'generation-id',
        GenerationProviderOperation.REPORT_GENERATION,
        'openai',
        'gpt-5-mini',
      ),
    ).rejects.toMatchObject<Partial<AiProviderError>>({
      code: 'AI_PROVIDER_CALL_BUDGET_EXHAUSTED',
      retryable: false,
    });
    expect(delegate.create).not.toHaveBeenCalled();
  });
});
