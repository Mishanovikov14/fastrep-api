import { ConfigService } from '@nestjs/config';
import { PdfReportService } from './pdf-report.service';

const onePixelJpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==',
  'base64',
);

describe('PdfReportService', () => {
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
});
