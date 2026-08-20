import { ConfigService } from '@nestjs/config';
import {
  ObjectStorageService,
  sanitizeContentDispositionFileName,
} from './object-storage.service';

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

  it('preserves Unicode while sanitizing Content-Disposition delimiters', () => {
    expect(
      sanitizeContentDispositionFileName('Звіт; "дах"/літо\\2026.pdf'),
    ).toBe('Звіт_ _дах__літо_2026.pdf');
  });

  it('sanitizes CR, LF, ASCII controls, and DEL deterministically', () => {
    expect(
      sanitizeContentDispositionFileName(
        `report\r\n${String.fromCharCode(0, 8, 31, 127)}.pdf`,
      ),
    ).toBe('report______.pdf');
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

  it('physically copies an object to an independent storage key and verifies it', async () => {
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({ ContentLength: 4 });

    await expect(
      service.copyObject(
        'users/user/reports/source/assets/photo one',
        'users/user/reports/duplicate/assets/copied',
      ),
    ).resolves.toEqual({ size: 4 });

    const calls = send.mock.calls as unknown as Array<[unknown]>;
    const copyCommand = calls[0]?.[0] as {
      input: { Bucket: string; CopySource: string; Key: string };
    };
    expect(copyCommand.input).toEqual({
      Bucket: 'private-bucket',
      CopySource: 'private-bucket/users/user/reports/source/assets/photo%20one',
      Key: 'users/user/reports/duplicate/assets/copied',
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
