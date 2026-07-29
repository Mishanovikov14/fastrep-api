import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiConflictResponse,
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
    ApiOperation({
      summary: 'Update one owned report',
      description:
        'Updates the report title and/or notes. Report status is server-managed.',
    }),
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
    ApiOperation({
      summary: 'Delete one owned report',
      description:
        'Deletes the report and cascaded asset metadata immediately. Private-object cleanup completes immediately or remains durably queued for retry.',
    }),
    ApiNoContentResponse({
      description:
        'Report deleted; object cleanup completed or was queued durably.',
    }),
    ApiConflictResponse({
      description:
        'REPORT_DELETE_CONFLICT: concurrent report changes prevented deletion after bounded retries.',
    }),
    ApiNotFoundResponse({ description: 'Report not found.' }),
  );
