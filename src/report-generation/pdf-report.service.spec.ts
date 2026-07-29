import { ConfigService } from '@nestjs/config';
import { AiProviderError } from '../ai/ai-provider.interface';
import { fontPathCandidates, PdfReportService } from './pdf-report.service';

const onePixelJpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==',
  'base64',
);

describe('PdfReportService', () => {
  it('includes the compiled worker layout when resolving packaged fonts', () => {
    expect(
      fontPathCandidates(
        '/srv/app/dist/src/report-generation',
        '/unrelated-working-directory',
        'NotoSans-Regular.ttf',
      ),
    ).toContain('/srv/app/assets/fonts/NotoSans-Regular.ttf');
  });

  it('fails safely when required packaged fonts are missing', async () => {
    const config = {
      get: jest.fn(),
    } as unknown as ConfigService;
    const service = new PdfReportService(config);
    const mutableService = service as unknown as {
      regularFontPath?: string;
      boldFontPath?: string;
    };
    mutableService.regularFontPath = undefined;
    mutableService.boldFontPath = undefined;

    await expect(
      service.generate(
        {
          title: 'Title',
          subtitle: null,
          summary: 'Summary',
          sections: [
            {
              title: 'Section',
              blocks: [{ type: 'paragraph', text: 'Text' }],
              imageAssetIds: [],
            },
          ],
          conclusion: null,
          recommendations: [],
        },
        [],
        new Date('2026-07-29T12:00:00.000Z'),
      ),
    ).rejects.toMatchObject<Partial<AiProviderError>>({
      code: 'PDF_FONT_MISSING',
    });
  });

  it('generates a bounded Unicode PDF with selected images', async () => {
    const config = {
      get: jest.fn((key: string) =>
        key === 'REPORT_OUTPUT_MAX_BYTES' ? '52428800' : undefined,
      ),
    } as unknown as ConfigService;
    const service = new PdfReportService(config);

    const bytes = await service.generate(
      {
        title: 'Звіт про огляд',
        subtitle: 'Безпечний Unicode',
        summary: 'Огляд даху виконано на основі наданих матеріалів.',
        sections: [
          {
            title: 'Спостереження',
            blocks: [
              {
                type: 'paragraph',
                text: 'На фотографії видно пошкодження покриття.',
              },
              {
                type: 'bulletList',
                items: ['Перевірити герметичність', 'Задокументувати ремонт'],
              },
            ],
            imageAssetIds: ['61c0f6d0-d4cc-4b52-944b-5db9d2374dc0'],
          },
        ],
        conclusion: 'Потрібен додатковий огляд фахівцем.',
        recommendations: ['Не вигадувати відсутні вимірювання.'],
      },
      [
        {
          assetId: '61c0f6d0-d4cc-4b52-944b-5db9d2374dc0',
          bytes: onePixelJpeg,
        },
      ],
      new Date('2026-07-29T12:00:00.000Z'),
      'uk',
    );

    expect(Buffer.from(bytes).subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(bytes.byteLength).toBeGreaterThan(1_000);
    expect(bytes.byteLength).toBeLessThan(52_428_800);
  });

  it('rejects aggregate image bytes above the configured PDF memory limit', async () => {
    const config = {
      get: jest.fn((key: string) =>
        key === 'REPORT_PDF_MAX_IMAGE_BYTES' ? '100' : undefined,
      ),
    } as unknown as ConfigService;
    const service = new PdfReportService(config);

    await expect(
      service.generate(
        {
          title: 'Title',
          subtitle: null,
          summary: 'Summary',
          sections: [
            {
              title: 'Section',
              blocks: [{ type: 'paragraph', text: 'Text' }],
              imageAssetIds: ['61c0f6d0-d4cc-4b52-944b-5db9d2374dc0'],
            },
          ],
          conclusion: null,
          recommendations: [],
        },
        [
          {
            assetId: '61c0f6d0-d4cc-4b52-944b-5db9d2374dc0',
            bytes: onePixelJpeg,
          },
        ],
        new Date('2026-07-29T12:00:00.000Z'),
      ),
    ).rejects.toMatchObject<Partial<AiProviderError>>({
      code: 'PDF_IMAGE_INPUT_TOO_LARGE',
    });
  });

  it('rejects generated output above the configured page limit', async () => {
    const config = {
      get: jest.fn((key: string) =>
        key === 'REPORT_PDF_MAX_PAGES' ? '1' : undefined,
      ),
    } as unknown as ConfigService;
    const service = new PdfReportService(config);

    await expect(
      service.generate(
        {
          title: 'Title',
          subtitle: null,
          summary: 'Long report',
          sections: [
            {
              title: 'Section',
              blocks: [
                {
                  type: 'paragraph',
                  text: 'Detailed observation. '.repeat(2_000),
                },
              ],
              imageAssetIds: [],
            },
          ],
          conclusion: null,
          recommendations: [],
        },
        [],
        new Date('2026-07-29T12:00:00.000Z'),
      ),
    ).rejects.toMatchObject<Partial<AiProviderError>>({
      code: 'REPORT_OUTPUT_TOO_MANY_PAGES',
    });
  });
});
