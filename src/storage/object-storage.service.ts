import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'node:stream';
import {
  PresignedDownloadContract,
  PresignedUploadContract,
  StoredObjectMetadata,
} from './storage.types';

const INSPECTION_RANGE_BYTES = 262_144;
const UNSAFE_CONTENT_DISPOSITION_CHARACTERS = new Set(['"', '\\', '/', ';']);

export const sanitizeContentDispositionFileName = (
  fileName: string,
): string => {
  return Array.from(fileName.normalize('NFKC'), (character) => {
    const codePoint = character.codePointAt(0);
    const isControlCharacter =
      codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    return isControlCharacter ||
      UNSAFE_CONTENT_DISPOSITION_CHARACTERS.has(character)
      ? '_'
      : character;
  }).join('');
};

@Injectable()
export class ObjectStorageService {
  private readonly bucket: string;
  private readonly client: S3Client;
  private readonly uploadUrlTtlSeconds: number;
  private readonly downloadUrlTtlSeconds: number;

  constructor(config: ConfigService) {
    this.bucket = config.get<string>('S3_BUCKET') ?? '';
    this.uploadUrlTtlSeconds = Number(
      config.get<string>('UPLOAD_URL_TTL_SECONDS') ?? '600',
    );
    this.downloadUrlTtlSeconds = Number(
      config.get<string>('DOWNLOAD_URL_TTL_SECONDS') ?? '600',
    );

    const accessKeyId = config.get<string>('S3_ACCESS_KEY_ID');
    const secretAccessKey = config.get<string>('S3_SECRET_ACCESS_KEY');
    this.client = new S3Client({
      endpoint: config.get<string>('S3_ENDPOINT') || undefined,
      region: config.get<string>('S3_REGION') || 'us-east-1',
      forcePathStyle: config.get<string>('S3_FORCE_PATH_STYLE') === 'true',
      requestHandler: new NodeHttpHandler({
        connectionTimeout: Number(
          config.get<string>('S3_REQUEST_TIMEOUT_MS') ?? '60000',
        ),
        socketTimeout: Number(
          config.get<string>('S3_REQUEST_TIMEOUT_MS') ?? '60000',
        ),
      }),
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

  async getObjectStream(storageKey: string): Promise<Readable> {
    this.ensureConfigured();
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }),
    );
    if (!(result.Body instanceof Readable)) {
      throw new Error('Stored object did not return a Node.js stream');
    }
    return result.Body;
  }

  async readObjectBytes(
    storageKey: string,
    maximumBytes: number,
  ): Promise<Uint8Array> {
    this.ensureConfigured();
    const metadata = await this.headObject(storageKey);
    if (!metadata || metadata.size > maximumBytes) {
      throw new Error('Stored object exceeds the allowed read size');
    }
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }),
    );
    if (!result.Body) {
      return new Uint8Array();
    }
    const bytes = await result.Body.transformToByteArray();
    if (bytes.byteLength > maximumBytes) {
      throw new Error('Stored object exceeds the allowed read size');
    }
    return bytes;
  }

  async uploadObject(
    storageKey: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<StoredObjectMetadata> {
    this.ensureConfigured();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        Body: bytes,
        ContentType: mimeType,
      }),
    );
    const metadata = await this.headObject(storageKey);
    if (!metadata || metadata.size !== bytes.byteLength) {
      throw new Error('Uploaded object verification failed');
    }
    return metadata;
  }

  async copyObject(
    sourceStorageKey: string,
    destinationStorageKey: string,
  ): Promise<StoredObjectMetadata> {
    this.ensureConfigured();
    const copySource = [this.bucket, ...sourceStorageKey.split('/')]
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: copySource,
        Key: destinationStorageKey,
      }),
    );
    const metadata = await this.headObject(destinationStorageKey);
    if (!metadata) {
      throw new Error('Copied object verification failed');
    }
    return metadata;
  }

  async createPresignedDownload(
    storageKey: string,
    fileName: string,
  ): Promise<PresignedDownloadContract> {
    this.ensureConfigured();
    const expiresAt = new Date(Date.now() + this.downloadUrlTtlSeconds * 1000);
    const safeFileName = sanitizeContentDispositionFileName(fileName);
    const asciiFallback = safeFileName
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    const encodedFileName = encodeURIComponent(safeFileName).replace(
      /['()]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        ResponseContentDisposition: `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedFileName}`,
        ResponseContentType: 'application/pdf',
      }),
      { expiresIn: this.downloadUrlTtlSeconds },
    );
    return { url, expiresAt };
  }

  async createPresignedGet(
    storageKey: string,
  ): Promise<PresignedDownloadContract> {
    this.ensureConfigured();
    const expiresAt = new Date(Date.now() + this.downloadUrlTtlSeconds * 1000);
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
      }),
      { expiresIn: this.downloadUrlTtlSeconds },
    );
    return { url, expiresAt };
  }

  async deleteObject(storageKey: string): Promise<void> {
    this.ensureConfigured();
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: storageKey,
        }),
      );
    } catch (error: unknown) {
      if (this.isNotFound(error)) {
        return;
      }

      throw error;
    }
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
