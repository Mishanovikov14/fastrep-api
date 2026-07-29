import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import PDFDocument from 'pdfkit';
import { AiProviderError } from '../ai/ai-provider.interface';
import { ReportResult } from '../ai/report-result.schema';

export type PdfImage = {
  assetId: string;
  bytes: Uint8Array;
};

@Injectable()
export class PdfReportService {
  private readonly maximumBytes: number;

  constructor(config: ConfigService) {
    this.maximumBytes = Number(
      config.get<string>('REPORT_OUTPUT_MAX_BYTES') ?? '52428800',
    );
  }

  async generate(
    result: ReportResult,
    images: PdfImage[],
    generatedAt: Date,
    language = 'en',
  ): Promise<Uint8Array> {
    const labels = this.labels(language);
    const imageMap = new Map(
      images.map((image) => [image.assetId, image.bytes]),
    );
    const document = new PDFDocument({
      size: 'A4',
      margins: { top: 64, bottom: 64, left: 64, right: 64 },
      bufferPages: true,
      info: {
        Title: result.title,
        Author: 'FastRep',
        Creator: 'FastRep backend',
        CreationDate: generatedAt,
        ModDate: generatedAt,
      },
    });
    document.registerFont(
      'NotoSans',
      join(process.cwd(), 'assets/fonts/NotoSans-Regular.ttf'),
    );
    document.registerFont(
      'NotoSansBold',
      join(process.cwd(), 'assets/fonts/NotoSans-Bold.ttf'),
    );

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const completed = new Promise<Uint8Array>((resolve, reject) => {
      document.on('data', (chunk: Buffer) => {
        totalBytes += chunk.byteLength;
        if (totalBytes > this.maximumBytes) {
          reject(
            new AiProviderError(
              'REPORT_OUTPUT_TOO_LARGE',
              false,
              'Generated PDF exceeds the configured size limit',
            ),
          );
          document.destroy();
          return;
        }
        chunks.push(chunk);
      });
      document.on('end', () => {
        const bytes = Buffer.concat(chunks);
        if (
          bytes.byteLength === 0 ||
          bytes.subarray(0, 5).toString('ascii') !== '%PDF-'
        ) {
          reject(
            new AiProviderError(
              'PDF_GENERATION_FAILED',
              false,
              'Generated output is not a valid PDF',
            ),
          );
          return;
        }
        resolve(bytes);
      });
      document.on('error', () => {
        reject(
          new AiProviderError(
            'PDF_GENERATION_FAILED',
            false,
            'PDF generation failed',
          ),
        );
      });
    });

    document.font('NotoSansBold').fontSize(24).text(result.title);
    if (result.subtitle) {
      document
        .moveDown(0.5)
        .font('NotoSans')
        .fontSize(14)
        .text(result.subtitle);
    }
    document
      .moveDown(1.5)
      .font('NotoSans')
      .fontSize(9)
      .fillColor('#555555')
      .text(generatedAt.toISOString());
    document
      .moveDown(2)
      .fillColor('#111111')
      .font('NotoSansBold')
      .fontSize(16)
      .text(labels.summary);
    document.moveDown(0.5).font('NotoSans').fontSize(11).text(result.summary);

    for (const section of result.sections) {
      this.ensureSpace(document, 100);
      document
        .moveDown(1.2)
        .font('NotoSansBold')
        .fontSize(16)
        .fillColor('#111111')
        .text(section.title);
      for (const block of section.blocks) {
        document.moveDown(0.5).font('NotoSans').fontSize(11);
        if (block.type === 'paragraph') {
          document.text(block.text);
        } else {
          for (const item of block.items) {
            document.text(`•  ${item}`, { indent: 12 });
          }
        }
      }
      for (const assetId of section.imageAssetIds) {
        const image = imageMap.get(assetId);
        if (!image) {
          continue;
        }
        this.ensureSpace(document, 260);
        document.moveDown(0.8);
        document.image(Buffer.from(image), {
          fit: [document.page.width - 128, 240],
          align: 'center',
          valign: 'center',
        });
      }
    }

    if (result.conclusion) {
      this.ensureSpace(document, 100);
      document
        .moveDown(1.2)
        .font('NotoSansBold')
        .fontSize(16)
        .text(labels.conclusion);
      document
        .moveDown(0.5)
        .font('NotoSans')
        .fontSize(11)
        .text(result.conclusion);
    }
    if (result.recommendations.length > 0) {
      this.ensureSpace(document, 100);
      document
        .moveDown(1.2)
        .font('NotoSansBold')
        .fontSize(16)
        .text(labels.recommendations);
      document.moveDown(0.5).font('NotoSans').fontSize(11);
      for (const recommendation of result.recommendations) {
        document.text(`•  ${recommendation}`, { indent: 12 });
      }
    }

    const range = document.bufferedPageRange();
    for (let index = 0; index < range.count; index += 1) {
      document.switchToPage(range.start + index);
      document.page.margins.bottom = 0;
      document
        .font('NotoSans')
        .fontSize(9)
        .fillColor('#777777')
        .text(`${index + 1} / ${range.count}`, 64, document.page.height - 42, {
          width: document.page.width - 128,
          align: 'center',
          lineBreak: false,
        });
    }
    document.end();
    return completed;
  }

  private ensureSpace(document: PDFKit.PDFDocument, points: number): void {
    if (document.y + points > document.page.height - 64) {
      document.addPage();
    }
  }

  private labels(language: string): {
    summary: string;
    conclusion: string;
    recommendations: string;
  } {
    const labels = {
      en: {
        summary: 'Summary',
        conclusion: 'Conclusion',
        recommendations: 'Recommendations',
      },
      uk: {
        summary: 'Резюме',
        conclusion: 'Висновок',
        recommendations: 'Рекомендації',
      },
      de: {
        summary: 'Zusammenfassung',
        conclusion: 'Fazit',
        recommendations: 'Empfehlungen',
      },
      fr: {
        summary: 'Résumé',
        conclusion: 'Conclusion',
        recommendations: 'Recommandations',
      },
      es: {
        summary: 'Resumen',
        conclusion: 'Conclusión',
        recommendations: 'Recomendaciones',
      },
    };
    return labels[language as keyof typeof labels] ?? labels.en;
  }
}
