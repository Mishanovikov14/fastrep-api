import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { CurrentUserId } from '../auth/current-user-id.decorator';
import { CreateReportDto } from './dto/create-report.dto';
import { ListReportsQueryDto } from './dto/list-reports-query.dto';
import { UpdateReportDto } from './dto/update-report.dto';
import { ReportsService } from './reports.service';
import {
  ApiCreateReport,
  ApiDeleteReport,
  ApiDuplicateReport,
  ApiGetReport,
  ApiListReports,
  ApiUpdateReport,
} from './swagger/reports.swagger';

@ApiTags('Reports')
@UseGuards(AccessTokenGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @ApiCreateReport()
  @Post()
  create(@CurrentUserId() userId: string, @Body() dto: CreateReportDto) {
    return this.reportsService.create(userId, dto);
  }

  @ApiListReports()
  @Get()
  findAll(
    @CurrentUserId() userId: string,
    @Query() query: ListReportsQueryDto,
  ) {
    return this.reportsService.findAll(userId, query.page, query.limit);
  }

  @ApiGetReport()
  @Get(':id')
  findOne(@CurrentUserId() userId: string, @Param('id') id: string) {
    return this.reportsService.findOne(userId, id);
  }

  @ApiUpdateReport()
  @Patch(':id')
  update(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateReportDto,
  ) {
    return this.reportsService.update(userId, id, dto);
  }

  @ApiDuplicateReport()
  @Post(':id/duplicate')
  duplicate(@CurrentUserId() userId: string, @Param('id') id: string) {
    return this.reportsService.duplicate(userId, id);
  }

  @ApiDeleteReport()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  delete(@CurrentUserId() userId: string, @Param('id') id: string) {
    return this.reportsService.delete(userId, id);
  }
}
