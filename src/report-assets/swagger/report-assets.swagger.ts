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
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ReportAssetResponseDto } from '../dto/report-asset-response.dto';
import { UploadRequestResponseDto } from '../dto/upload-request-response.dto';

const authenticatedEndpoint = () =>
  applyDecorators(
    ApiBearerAuth('access-token'),
    ApiUnauthorizedResponse({
      description: 'Missing, invalid, or expired access token.',
    }),
    ApiNotFoundResponse({
      description: 'The owned report or asset was not found.',
    }),
  );

export const ApiRequestAssetUpload = () =>
  applyDecorators(
    authenticatedEndpoint(),
    ApiOperation({
      summary: 'Request a direct report-asset upload',
      description:
        'Creates a pending asset and returns a short-lived presigned POST. Submit the returned fields unchanged directly to private object storage.',
    }),
    ApiCreatedResponse({
      type: UploadRequestResponseDto,
      description: 'A pending asset and upload contract were created.',
    }),
    ApiBadRequestResponse({
      description: 'Invalid type, size, report state, or report limits.',
    }),
    ApiConflictResponse({
      description:
        'UPLOAD_SLOT_CONFLICT: concurrent reservation could not be completed after bounded retries.',
    }),
    ApiTooManyRequestsResponse({
      description: 'Upload-contract creation rate limit exceeded.',
    }),
    ApiServiceUnavailableResponse({
      description:
        'OBJECT_STORAGE_UNAVAILABLE: object storage is temporarily unavailable.',
    }),
  );

export const ApiConfirmAssetUpload = () =>
  applyDecorators(
    authenticatedEndpoint(),
    ApiOperation({
      summary: 'Confirm and validate a direct upload',
      description:
        'Verifies object existence, exact size, signature, category, and applicable media limits before marking the asset ready.',
    }),
    ApiOkResponse({
      type: ReportAssetResponseDto,
      description:
        'The ready asset. Confirming an already-ready asset is safe.',
    }),
    ApiBadRequestResponse({
      description: 'The upload expired, was rejected, or failed validation.',
    }),
    ApiServiceUnavailableResponse({
      description:
        'OBJECT_STORAGE_UNAVAILABLE: object storage is temporarily unavailable.',
    }),
  );

export const ApiListReportAssets = () =>
  applyDecorators(
    authenticatedEndpoint(),
    ApiOperation({ summary: 'List assets for an owned report' }),
    ApiOkResponse({
      type: ReportAssetResponseDto,
      isArray: true,
      description:
        'Asset metadata and safe rejection codes ordered by position and creation time. Internal keys and provider credentials are excluded.',
    }),
  );

export const ApiDownloadReportAsset = () =>
  applyDecorators(
    authenticatedEndpoint(),
    ApiOperation({
      summary: 'Request a private report-asset download URL',
      description:
        'Returns a fresh short-lived URL for a ready asset. The URL must not be persisted or exposed to another user.',
    }),
    ApiOkResponse({
      description: 'A short-lived private download contract.',
      schema: {
        type: 'object',
        required: ['url', 'expiresAt'],
        properties: {
          url: { type: 'string', format: 'uri' },
          expiresAt: { type: 'string', format: 'date-time' },
        },
      },
    }),
    ApiBadRequestResponse({
      description: 'ASSET_NOT_READY: only ready assets can be downloaded.',
    }),
    ApiServiceUnavailableResponse({
      description:
        'OBJECT_STORAGE_UNAVAILABLE: object storage is temporarily unavailable.',
    }),
  );

export const ApiDeleteReportAsset = () =>
  applyDecorators(
    authenticatedEndpoint(),
    ApiOperation({ summary: 'Delete an owned report asset' }),
    ApiNoContentResponse({
      description:
        'The database asset was deleted. Object cleanup completed immediately or was durably queued for retry.',
    }),
  );
