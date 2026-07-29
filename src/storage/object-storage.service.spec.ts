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

  it('HEAD-verifies an uploaded output before returning success', async () => {
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({ ContentLength: 4 });

    await expect(
      service.uploadObject(
        'private-output.pdf',
        Uint8Array.from([1, 2, 3, 4]),
        'application/pdf',
      ),
    ).resolves.toEqual({ size: 4 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('rejects publication when uploaded output verification mismatches', async () => {
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({ ContentLength: 3 });

    await expect(
      service.uploadObject(
        'partial-output.pdf',
        Uint8Array.from([1, 2, 3, 4]),
        'application/pdf',
      ),
    ).rejects.toThrow('Uploaded object verification failed');
  });
});
