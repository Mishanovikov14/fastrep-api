import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PresignedUploadContract, StoredObjectMetadata } from './storage.types';

const INSPECTION_RANGE_BYTES = 262_144;

@Injectable()
export class ObjectStorageService {
  private readonly bucket: string;
  private readonly client: S3Client;
  private readonly uploadUrlTtlSeconds: number;

  constructor(config: ConfigService) {
    this.bucket = config.get<string>('S3_BUCKET') ?? '';
    this.uploadUrlTtlSeconds = Number(
      config.get<string>('UPLOAD_URL_TTL_SECONDS') ?? '600',
    );

    const accessKeyId = config.get<string>('S3_ACCESS_KEY_ID');
    const secretAccessKey = config.get<string>('S3_SECRET_ACCESS_KEY');
    this.client = new S3Client({
      endpoint: config.get<string>('S3_ENDPOINT') || undefined,
      region: config.get<string>('S3_REGION') || 'us-east-1',
      forcePathStyle: config.get<string>('S3_FORCE_PATH_STYLE') === 'true',
      credentials:
        accessKeyId && secretAccessKey
          ? { accessKeyId, secretAccessKey }
          : undefined,
    });
  }

  async createPresignedUpload(
    storageKey: string,
    mimeType: string,
    maximumBytes: number,
  ): Promise<PresignedUploadContract> {
    this.ensureConfigured();
    const expiresAt = new Date(Date.now() + this.uploadUrlTtlSeconds * 1000);
    const contract = await createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: storageKey,
      Fields: {
        key: storageKey,
        'Content-Type': mimeType,
      },
      Conditions: [
        ['eq', '$key', storageKey],
        ['eq', '$Content-Type', mimeType],
        ['content-length-range', 1, maximumBytes],
      ],
      Expires: this.uploadUrlTtlSeconds,
    });

    return {
      method: 'POST',
      url: contract.url,
      fields: contract.fields,
      expiresAt,
    };
  }

  async headObject(storageKey: string): Promise<StoredObjectMetadata | null> {
    this.ensureConfigured();

    try {
      const result = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: storageKey,
        }),
      );

      return {
        size: result.ContentLength ?? 0,
      };
    } catch (error: unknown) {
      if (this.isNotFound(error)) {
        return null;
      }

      throw error;
    }
  }

  async readInspectionBytes(storageKey: string): Promise<Uint8Array> {
    this.ensureConfigured();
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        Range: `bytes=0-${INSPECTION_RANGE_BYTES - 1}`,
      }),
    );

    if (!result.Body) {
      return new Uint8Array();
    }

    const bytes = await result.Body.transformToByteArray();
    return bytes.slice(0, INSPECTION_RANGE_BYTES);
  }

  async deleteObject(storageKey: string): Promise<void> {
    this.ensureConfigured();
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
      }),
    );
  }

  private ensureConfigured(): void {
    if (!this.bucket) {
      throw new Error('Object storage is not configured');
    }
  }

  private isNotFound(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const candidate = error as {
      name?: unknown;
      $metadata?: { httpStatusCode?: unknown };
    };

    return (
      candidate.name === 'NotFound' ||
      candidate.name === 'NoSuchKey' ||
      candidate.$metadata?.httpStatusCode === 404
    );
  }
}
