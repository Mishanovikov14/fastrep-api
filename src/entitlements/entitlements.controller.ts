import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { CurrentUserId } from '../auth/current-user-id.decorator';
import { EntitlementsService } from './entitlements.service';

@ApiTags('Entitlements')
@ApiBearerAuth('access-token')
@UseGuards(AccessTokenGuard)
@Controller('me/entitlements')
export class EntitlementsController {
  constructor(private readonly entitlements: EntitlementsService) {}

  @ApiOkResponse({
    description: 'Current subscription and generation credits',
    schema: {
      type: 'object',
      properties: {
        subscription: {
          nullable: true,
          type: 'object',
          properties: {
            planCode: { type: 'string' },
            status: { type: 'string' },
            currentPeriodEnd: { type: 'string', format: 'date-time' },
          },
        },
        generationCredits: {
          type: 'object',
          properties: {
            available: { type: 'integer' },
            monthly: { type: 'integer' },
            purchased: { type: 'integer' },
          },
        },
        canGenerate: { type: 'boolean' },
      },
    },
  })
  @Get()
  get(@CurrentUserId() userId: string) {
    return this.entitlements.getForUser(userId);
  }
}
