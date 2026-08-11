import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { CurrentUserId } from '../auth/current-user-id.decorator';
import { RequestAssetUploadDto } from './dto/request-asset-upload.dto';
import { ReportAssetsService } from './report-assets.service';
import {
  ApiConfirmAssetUpload,
  ApiDeleteReportAsset,
  ApiDownloadReportAsset,
  ApiListReportAssets,
  ApiRequestAssetUpload,
} from './swagger/report-assets.swagger';

@ApiTags('Report Assets')
@UseGuards(AccessTokenGuard)
@Controller('reports/:reportId/assets')
export class ReportAssetsController {
  constructor(private readonly reportAssetsService: ReportAssetsService) {}

  @ApiRequestAssetUpload()
  @Throttle({ assetUpload: { limit: 20, ttl: 60_000 } })
  @UseGuards(ThrottlerGuard)
  @Post('upload-request')
  requestUpload(
    @CurrentUserId() userId: string,
    @Param('reportId') reportId: string,
    @Body() dto: RequestAssetUploadDto,
  ): ReturnType<ReportAssetsService['requestUpload']> {
    return this.reportAssetsService.requestUpload(userId, reportId, dto);
  }

  @ApiConfirmAssetUpload()
  @HttpCode(HttpStatus.OK)
  @Post(':assetId/confirm')
  confirmUpload(
    @CurrentUserId() userId: string,
    @Param('reportId') reportId: string,
    @Param('assetId') assetId: string,
  ): ReturnType<ReportAssetsService['confirmUpload']> {
    return this.reportAssetsService.confirmUpload(userId, reportId, assetId);
  }

  @ApiListReportAssets()
  @Get()
  list(
    @CurrentUserId() userId: string,
    @Param('reportId') reportId: string,
  ): ReturnType<ReportAssetsService['list']> {
    return this.reportAssetsService.list(userId, reportId);
  }

  @ApiDownloadReportAsset()
  @HttpCode(HttpStatus.OK)
  @Post(':assetId/download-url')
  createDownloadUrl(
    @CurrentUserId() userId: string,
    @Param('reportId') reportId: string,
    @Param('assetId') assetId: string,
  ): ReturnType<ReportAssetsService['createDownloadUrl']> {
    return this.reportAssetsService.createDownloadUrl(
      userId,
      reportId,
      assetId,
    );
  }

  @ApiDeleteReportAsset()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':assetId')
  delete(
    @CurrentUserId() userId: string,
    @Param('reportId') reportId: string,
    @Param('assetId') assetId: string,
  ): ReturnType<ReportAssetsService['delete']> {
    return this.reportAssetsService.delete(userId, reportId, assetId);
  }
}
