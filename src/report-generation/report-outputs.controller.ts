import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { CurrentUserId } from '../auth/current-user-id.decorator';
import { ReportOutputsService } from './report-outputs.service';

@ApiTags('Report output')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller('reports/:reportId/output')
export class ReportOutputsController {
  constructor(private readonly outputs: ReportOutputsService) {}

  @ApiOkResponse({
    description: 'Private report output metadata (storage key excluded)',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        generationId: { type: 'string', format: 'uuid' },
        type: { type: 'string', enum: ['PDF'] },
        mimeType: { type: 'string', example: 'application/pdf' },
        size: { type: 'integer', example: 123456 },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @Get()
  get(@CurrentUserId() userId: string, @Param('reportId') reportId: string) {
    return this.outputs.getMetadata(userId, reportId);
  }

  @ApiOkResponse({
    description: 'Short-lived private download URL',
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri' },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @Post('download-url')
  createDownloadUrl(
    @CurrentUserId() userId: string,
    @Param('reportId') reportId: string,
  ) {
    return this.outputs.createDownloadUrl(userId, reportId);
  }
}
