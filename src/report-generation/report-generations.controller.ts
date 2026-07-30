import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { CurrentUserId } from '../auth/current-user-id.decorator';
import { ReportGenerationsService } from './report-generations.service';

@ApiTags('Report generations')
@ApiBearerAuth('access-token')
@UseGuards(AccessTokenGuard)
@Controller('reports/:reportId/generations')
export class ReportGenerationsController {
  constructor(private readonly generations: ReportGenerationsService) {}

  @ApiAcceptedResponse({ description: 'Generation queued' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Stable key for this user/report generation request',
  })
  @HttpCode(HttpStatus.ACCEPTED)
  @Post()
  create(
    @CurrentUserId() userId: string,
    @Param('reportId') reportId: string,
    @Headers('idempotency-key') idempotencyKey = '',
  ) {
    return this.generations.create(userId, reportId, idempotencyKey);
  }

  @ApiOkResponse({ description: 'Latest generation' })
  @Get('latest')
  latest(@CurrentUserId() userId: string, @Param('reportId') reportId: string) {
    return this.generations.latest(userId, reportId);
  }

  @ApiOkResponse({ description: 'Generation status and progress' })
  @Get(':generationId')
  findOne(
    @CurrentUserId() userId: string,
    @Param('reportId') reportId: string,
    @Param('generationId') generationId: string,
  ) {
    return this.generations.findOne(userId, reportId, generationId);
  }

  @ApiAcceptedResponse({ description: 'New retry generation queued' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'New stable key for this retry request',
  })
  @HttpCode(HttpStatus.ACCEPTED)
  @Post(':generationId/retry')
  retry(
    @CurrentUserId() userId: string,
    @Param('reportId') reportId: string,
    @Param('generationId') generationId: string,
    @Headers('idempotency-key') idempotencyKey = '',
  ) {
    return this.generations.retry(
      userId,
      reportId,
      generationId,
      idempotencyKey,
    );
  }

  @ApiOkResponse({ description: 'Queued generation cancelled' })
  @Post(':generationId/cancel')
  cancel(
    @CurrentUserId() userId: string,
    @Param('reportId') reportId: string,
    @Param('generationId') generationId: string,
  ) {
    return this.generations.cancel(userId, reportId, generationId);
  }
}
