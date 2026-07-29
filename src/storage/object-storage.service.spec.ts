import { ConfigService } from '@nestjs/config';
import { ObjectStorageService } from './object-storage.service';

describe('ObjectStorageService', () => {
  let service: ObjectStorageService;
  let send: jest.Mock;

  beforeEach(() => {
    const values: Record<string, string> = {
      S3_BUCKET: 'private-bucket',
      S3_REGION: 'us-east-1',
      S3_FORCE_PATH_STYLE: 'false',
      UPLOAD_URL_TTL_SECONDS: '600',
    };
    const config = {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
    service = new ObjectStorageService(config);
    send = jest.fn();
    (
      service as unknown as {
        client: { send: jest.Mock };
      }
    ).client.send = send;
  });

  it('treats a provider not-found response as successful deletion', async () => {
    send.mockRejectedValue({
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    });

    await expect(service.deleteObject('missing-key')).resolves.toBeUndefined();
  });

  it('rethrows temporary provider deletion failures for durable retry', async () => {
    send.mockRejectedValue({
      name: 'ServiceUnavailable',
      $metadata: { httpStatusCode: 503 },
    });

    await expect(service.deleteObject('known-key')).rejects.toMatchObject({
      name: 'ServiceUnavailable',
    });
  });
});
