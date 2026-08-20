import { ConfigService } from '@nestjs/config';
import PDFDocument from 'pdfkit';
import { AiProviderError } from '../ai/ai-provider.interface';
import {
  fitImageDimensions,
  fontPathCandidates,
  formatReportDate,
  galleryColumnCount,
  needsPageBreak,
  PdfReportService,
  sanitizePdfText,
} from './pdf-report.service';

const onePixelJpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==',
  'base64',
);

describe('PdfReportService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

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
      'Огляд будинку',
    );

    expect(Buffer.from(bytes).subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(bytes.byteLength).toBeGreaterThan(1_000);
    expect(bytes.byteLength).toBeLessThan(52_428_800);
  });

  it('formats generated dates in the captured timezone and report language', () => {
    const date = new Date('2026-08-19T19:32:16.876Z');
    const originalTimestamp = date.toISOString();

    expect(formatReportDate(date, 'uk', 'Europe/Kyiv')).toBe(
      '19 серпня 2026 р. о 22:32',
    );
    expect(formatReportDate(date, 'en', 'America/New_York')).toBe(
      '19 August 2026 at 15:32',
    );
    expect(date.toISOString()).toBe(originalTimestamp);
  });

  it('marks UTC explicitly when a snapshot timezone is missing or invalid', () => {
    const date = new Date('2026-08-19T19:32:16.876Z');

    expect(formatReportDate(date, 'en')).toBe('19 August 2026 at 19:32 UTC');
    expect(formatReportDate(date, 'unknown', 'Invalid/Timezone')).toBe(
      '19 August 2026 at 19:32 UTC',
    );
  });

  it('removes provider aliases and raw image asset IDs from rendered text', async () => {
    const assetId = '61c0f6d0-d4cc-4b52-944b-5db9d2374dc0';
    const textSpy = jest.spyOn(PDFDocument.prototype, 'text');
    const service = createService();

    await service.generate(
      {
        title: 'AI title should not be used',
        subtitle: 'IMAGE_1 details',
        summary: `IMAGE_1 corresponds to ${assetId}`,
        sections: [
          {
            title: 'Findings',
            blocks: [{ type: 'paragraph', text: `IMAGE_1 shows ${assetId}` }],
            imageAssetIds: [],
          },
        ],
        conclusion: null,
        recommendations: [],
      },
      [{ assetId, bytes: onePixelJpeg }],
      new Date('2026-08-19T19:32:16.876Z'),
      'en',
      'User supplied report title',
      'UTC',
    );

    const renderedText = textSpy.mock.calls
      .map((call) => call[0])
      .filter((value): value is string => typeof value === 'string')
      .join('\n');
    expect(renderedText).toContain('User supplied report title');
    expect(renderedText).toContain('19 August 2026 at 19:32');
    expect(renderedText).not.toContain('IMAGE_1');
    expect(renderedText).not.toContain(assetId);
    expect(renderedText).not.toContain('2026-08-19T19:32:16.876Z');
  });

  it('renders a repeated image asset only once across the document', async () => {
    const imageSpy = jest.spyOn(PDFDocument.prototype, 'image');
    const service = createService();
    const assetId = '61c0f6d0-d4cc-4b52-944b-5db9d2374dc0';

    await service.generate(
      {
        title: 'Title',
        subtitle: null,
        summary: 'Summary',
        sections: [
          {
            title: 'First',
            blocks: [{ type: 'paragraph', text: 'First observation.' }],
            imageAssetIds: [assetId],
          },
          {
            title: 'Second',
            blocks: [{ type: 'paragraph', text: 'Related discussion.' }],
            imageAssetIds: [assetId],
          },
        ],
        conclusion: null,
        recommendations: [],
      },
      [{ assetId, bytes: onePixelJpeg }],
      new Date('2026-08-19T19:32:16.876Z'),
    );

    expect(imageSpy).toHaveBeenCalledTimes(1);
  });

  it('uses a compact two-column grid for four images', async () => {
    const imageSpy = jest.spyOn(PDFDocument.prototype, 'image');
    const service = createService();
    const images = Array.from({ length: 4 }, (_, index) => ({
      assetId: `00000000-0000-4000-8000-00000000000${index}`,
      bytes: onePixelJpeg,
    }));

    await service.generate(
      {
        title: 'Title',
        subtitle: null,
        summary: 'Summary',
        sections: [
          {
            title: 'Gallery',
            blocks: [{ type: 'paragraph', text: 'Four photographs.' }],
            imageAssetIds: images.map((image) => image.assetId),
          },
        ],
        conclusion: null,
        recommendations: [],
      },
      images,
      new Date('2026-08-19T19:32:16.876Z'),
    );

    const positions = imageSpy.mock.calls.map((call) => ({
      x: call[1],
      y: call[2],
    }));
    expect(galleryColumnCount(4)).toBe(2);
    expect(new Set(positions.map((position) => position.x)).size).toBe(2);
    expect(new Set(positions.map((position) => position.y)).size).toBe(2);
  });

  it('preserves aspect ratio and never upscales images', () => {
    expect(fitImageDimensions(1200, 2400, 240, 150)).toEqual({
      width: 75,
      height: 150,
    });
    expect(fitImageDimensions(40, 20, 240, 150)).toEqual({
      width: 40,
      height: 20,
    });
  });

  it('starts a new page when a heading and initial content would be orphaned', () => {
    expect(needsPageBreak(730, 80, 776)).toBe(true);
    expect(needsPageBreak(650, 80, 776)).toBe(false);
  });

  it('generates zero-image and text-only reports', async () => {
    const service = createService();
    const result = {
      title: 'Text report',
      subtitle: null,
      summary: 'Summary',
      sections: [
        {
          title: 'Details',
          blocks: [{ type: 'paragraph' as const, text: 'Text only.' }],
          imageAssetIds: [],
        },
      ],
      conclusion: null,
      recommendations: [],
    };

    const zeroImageBytes = await service.generate(
      result,
      [],
      new Date('2026-08-19T19:32:16.876Z'),
    );
    const textOnlyBytes = await service.generate(
      { ...result, summary: 'A longer text-only summary. '.repeat(20) },
      [],
      new Date('2026-08-19T19:32:16.876Z'),
    );

    expect(Buffer.from(zeroImageBytes).subarray(0, 5).toString('ascii')).toBe(
      '%PDF-',
    );
    expect(Buffer.from(textOnlyBytes).subarray(0, 5).toString('ascii')).toBe(
      '%PDF-',
    );
  });

  it('paginates a twenty-image gallery without overflowing the page limit', async () => {
    const service = createService();
    const images = Array.from({ length: 20 }, (_, index) => ({
      assetId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      bytes: onePixelJpeg,
    }));

    const bytes = await service.generate(
      {
        title: 'Large gallery',
        subtitle: null,
        summary: 'Summary',
        sections: [
          {
            title: 'Photographs',
            blocks: [{ type: 'paragraph', text: 'Documented conditions.' }],
            imageAssetIds: images.map((image) => image.assetId),
          },
        ],
        conclusion: null,
        recommendations: [],
      },
      images,
      new Date('2026-08-19T19:32:16.876Z'),
    );

    expect(Buffer.from(bytes).subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('sanitizes aliases independently of PDF rendering', () => {
    expect(
      sanitizePdfText(
        'IMAGE_12 shows asset-id',
        new Set(['asset-id']),
        'photograph',
      ),
    ).toBe('photograph shows photograph');
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

function createService(): PdfReportService {
  return new PdfReportService({ get: jest.fn() } as unknown as ConfigService);
}
