import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { PaginatedReportsDto } from '../dto/paginated-reports.dto';
import { ReportResponseDto } from '../dto/report-response.dto';

const authenticatedEndpoint = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiUnauthorizedResponse({
      description: 'Missing, invalid, or expired access token.',
    }),
  );

export const ApiCreateReport = () =>
  applyDecorators(
    authenticatedEndpoint(),
    ApiOperation({ summary: 'Create a report' }),
    ApiCreatedResponse({
      description: 'Report created in DRAFT status.',
      type: ReportResponseDto,
    }),
    ApiBadRequestResponse({ description: 'Invalid report data.' }),
  );

export const ApiListReports = () =>
  applyDecorators(
    authenticatedEndpoint(),
    ApiOperation({ summary: 'List the current user’s reports' }),
    ApiOkResponse({
      description: 'Reports returned newest first.',
      type: PaginatedReportsDto,
    }),
    ApiBadRequestResponse({ description: 'Invalid pagination parameters.' }),
  );

export const ApiGetReport = () =>
  applyDecorators(
    authenticatedEndpoint(),
    ApiOperation({ summary: 'Get one owned report' }),
    ApiOkResponse({
      description: 'Report returned successfully.',
      type: ReportResponseDto,
    }),
    ApiNotFoundResponse({ description: 'Report not found.' }),
  );

export const ApiUpdateReport = () =>
  applyDecorators(
    authenticatedEndpoint(),
    ApiOperation({ summary: 'Update one owned report' }),
    ApiOkResponse({
      description: 'Report updated successfully.',
      type: ReportResponseDto,
    }),
    ApiBadRequestResponse({ description: 'Invalid report data.' }),
    ApiNotFoundResponse({ description: 'Report not found.' }),
  );

export const ApiDeleteReport = () =>
  applyDecorators(
    authenticatedEndpoint(),
    ApiOperation({ summary: 'Delete one owned report' }),
    ApiNoContentResponse({ description: 'Report deleted successfully.' }),
    ApiNotFoundResponse({ description: 'Report not found.' }),
  );
