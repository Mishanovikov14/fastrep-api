import { existsSync } from 'node:fs';
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

type ImageDimensions = {
  width: number;
  height: number;
};

type PdfDocumentWithImageDimensions = PDFKit.PDFDocument & {
  openImage(source: Buffer): ImageDimensions;
};

type ReportLabels = {
  generated: string;
  summary: string;
  conclusion: string;
  recommendations: string;
  photograph: string;
};

const PAGE_MARGIN_X = 56;
const PAGE_MARGIN_TOP = 62;
const PAGE_MARGIN_BOTTOM = 66;
const FOOTER_Y_OFFSET = 38;
const GALLERY_GAP = 12;
const SINGLE_IMAGE_MAX_WIDTH = 360;
const SINGLE_IMAGE_MAX_HEIGHT = 160;
const GRID_IMAGE_MAX_HEIGHT = 150;
const CLOSING_SECTIONS_MIN_HEIGHT = 175;

const COLORS = {
  accent: '#176B73',
  text: '#17252A',
  muted: '#66757A',
  divider: '#D8E2E4',
} as const;

const DATE_LOCALES = {
  en: 'en-GB',
  uk: 'uk-UA',
  de: 'de-DE',
  fr: 'fr-FR',
  es: 'es-ES',
} as const;

export const fontPathCandidates = (
  runtimeDirectory: string,
  workingDirectory: string,
  fileName: string,
): string[] => [
  join(workingDirectory, 'assets/fonts', fileName),
  join(runtimeDirectory, '../../assets/fonts', fileName),
  join(runtimeDirectory, '../../../assets/fonts', fileName),
];

export const formatReportDate = (
  date: Date,
  language: string,
  timezone?: string | null,
): string => {
  const locale =
    DATE_LOCALES[language as keyof typeof DATE_LOCALES] ?? DATE_LOCALES.en;
  let resolvedTimezone = timezone?.trim() || 'UTC';
  let isUtcFallback = !timezone?.trim();
  let formatted: string;

  try {
    formatted = new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: resolvedTimezone,
    }).format(date);
  } catch {
    resolvedTimezone = 'UTC';
    isUtcFallback = true;
    formatted = new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: resolvedTimezone,
    }).format(date);
  }

  return isUtcFallback ? `${formatted} UTC` : formatted;
};

export const fitImageDimensions = (
  sourceWidth: number,
  sourceHeight: number,
  maximumWidth: number,
  maximumHeight: number,
): ImageDimensions => {
  const scale = Math.min(
    maximumWidth / sourceWidth,
    maximumHeight / sourceHeight,
    1,
  );
  return {
    width: sourceWidth * scale,
    height: sourceHeight * scale,
  };
};

export const galleryColumnCount = (imageCount: number): 1 | 2 =>
  imageCount === 1 ? 1 : 2;

export const needsPageBreak = (
  currentY: number,
  requiredHeight: number,
  contentBottom: number,
): boolean => currentY + requiredHeight > contentBottom;

export const sanitizePdfText = (
  value: string,
  hiddenAssetIds: ReadonlySet<string>,
  photographLabel: string,
): string => {
  let sanitized = value.replace(/\bIMAGE_\d+\b/gi, photographLabel);
  for (const assetId of hiddenAssetIds) {
    sanitized = sanitized.replaceAll(assetId, photographLabel);
  }
  return sanitized;
};

@Injectable()
export class PdfReportService {
  private readonly maximumBytes: number;
  private readonly maximumPages: number;
  private readonly maximumImageBytes: number;
  private readonly regularFontPath?: string;
  private readonly boldFontPath?: string;

  constructor(config: ConfigService) {
    this.maximumBytes = Number(
      config.get<string>('REPORT_OUTPUT_MAX_BYTES') ?? '52428800',
    );
    this.maximumPages = Number(
      config.get<string>('REPORT_PDF_MAX_PAGES') ?? '100',
    );
    this.maximumImageBytes = Number(
      config.get<string>('REPORT_PDF_MAX_IMAGE_BYTES') ?? '52428800',
    );
    this.regularFontPath = this.resolveFont('NotoSans-Regular.ttf');
    this.boldFontPath = this.resolveFont('NotoSans-Bold.ttf');
  }

  async generate(
    result: ReportResult,
    images: PdfImage[],
    generatedAt: Date,
    language = 'en',
    reportTitle = result.title,
    timezone?: string | null,
  ): Promise<Uint8Array> {
    if (!this.regularFontPath || !this.boldFontPath) {
      throw new AiProviderError(
        'PDF_FONT_MISSING',
        false,
        'Required PDF fonts are unavailable',
      );
    }
    const imageBytes = images.reduce(
      (total, image) => total + image.bytes.byteLength,
      0,
    );
    if (imageBytes > this.maximumImageBytes) {
      throw new AiProviderError(
        'PDF_IMAGE_INPUT_TOO_LARGE',
        false,
        'PDF image input exceeds the configured memory limit',
      );
    }

    const labels = this.labels(language);
    const hiddenAssetIds = new Set(images.map((image) => image.assetId));
    const visibleText = (value: string): string =>
      sanitizePdfText(value, hiddenAssetIds, labels.photograph);
    const visibleTitle = visibleText(reportTitle);
    const imageMap = new Map(
      images.map((image) => [image.assetId, image.bytes]),
    );
    const renderedImageAssetIds = new Set<string>();
    const document = new PDFDocument({
      size: 'A4',
      margins: {
        top: PAGE_MARGIN_TOP,
        bottom: PAGE_MARGIN_BOTTOM,
        left: PAGE_MARGIN_X,
        right: PAGE_MARGIN_X,
      },
      bufferPages: true,
      info: {
        Title: visibleTitle,
        Author: 'FastRep',
        Creator: 'FastRep',
        CreationDate: generatedAt,
        ModDate: generatedAt,
      },
    });
    document.registerFont('NotoSans', this.regularFontPath);
    document.registerFont('NotoSansBold', this.boldFontPath);

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

    this.renderCover(
      document,
      visibleTitle,
      result.subtitle ? visibleText(result.subtitle) : null,
      generatedAt,
      language,
      timezone,
      labels,
    );
    this.renderNamedSection(
      document,
      labels.summary,
      visibleText(result.summary),
    );

    for (const section of result.sections) {
      const firstBlockText =
        section.blocks[0].type === 'paragraph'
          ? section.blocks[0].text
          : section.blocks[0].items[0];
      this.ensureSectionSpace(document, visibleText(firstBlockText));
      this.renderSectionHeading(document, visibleText(section.title));
      for (const block of section.blocks) {
        document.moveDown(0.45).font('NotoSans').fontSize(10.5);
        if (block.type === 'paragraph') {
          document
            .fillColor(COLORS.text)
            .text(visibleText(block.text), { lineGap: 2.5 });
        } else {
          for (const item of block.items) {
            document
              .fillColor(COLORS.text)
              .text(`•  ${visibleText(item)}`, { indent: 12, lineGap: 2.5 });
          }
        }
      }

      const sectionImages = section.imageAssetIds.flatMap((assetId) => {
        if (renderedImageAssetIds.has(assetId)) {
          return [];
        }
        const bytes = imageMap.get(assetId);
        if (!bytes) {
          return [];
        }
        renderedImageAssetIds.add(assetId);
        return [{ assetId, bytes }];
      });
      this.renderGallery(document, sectionImages);
    }

    if (result.conclusion) {
      if (result.recommendations.length > 0) {
        this.ensureSpace(document, CLOSING_SECTIONS_MIN_HEIGHT);
      }
      this.renderNamedSection(
        document,
        labels.conclusion,
        visibleText(result.conclusion),
      );
    }
    if (result.recommendations.length > 0) {
      const firstRecommendation = visibleText(result.recommendations[0]);
      this.ensureSectionSpace(document, firstRecommendation);
      this.renderSectionHeading(document, labels.recommendations);
      document.moveDown(0.45).font('NotoSans').fontSize(10.5);
      for (const recommendation of result.recommendations) {
        document
          .fillColor(COLORS.text)
          .text(`•  ${visibleText(recommendation)}`, {
            indent: 12,
            lineGap: 2.5,
          });
      }
    }

    const range = document.bufferedPageRange();
    if (range.count > this.maximumPages) {
      document.end();
      await completed;
      throw new AiProviderError(
        'REPORT_OUTPUT_TOO_MANY_PAGES',
        false,
        'Generated PDF exceeds the configured page limit',
      );
    }
    this.renderPageChrome(document, range, visibleTitle);
    document.end();
    return completed;
  }

  private renderCover(
    document: PDFKit.PDFDocument,
    title: string,
    description: string | null,
    generatedAt: Date,
    language: string,
    timezone: string | null | undefined,
    labels: ReportLabels,
  ): void {
    document
      .font('NotoSansBold')
      .fontSize(10)
      .fillColor(COLORS.accent)
      .text('FASTREP', { characterSpacing: 1.8 });
    document
      .moveDown(1.35)
      .font('NotoSansBold')
      .fontSize(26)
      .fillColor(COLORS.text)
      .text(title, { lineGap: 2 });
    if (description) {
      document
        .moveDown(0.55)
        .font('NotoSans')
        .fontSize(12)
        .fillColor(COLORS.muted)
        .text(description, { lineGap: 2 });
    }
    document
      .moveDown(1.35)
      .font('NotoSans')
      .fontSize(9.5)
      .fillColor(COLORS.muted)
      .text(
        `${labels.generated}: ${formatReportDate(
          generatedAt,
          language,
          timezone,
        )}`,
      );
    document.moveDown(1.25);
    document
      .strokeColor(COLORS.divider)
      .lineWidth(0.8)
      .moveTo(PAGE_MARGIN_X, document.y)
      .lineTo(document.page.width - PAGE_MARGIN_X, document.y)
      .stroke();
    document.moveDown(1.25);
  }

  private renderNamedSection(
    document: PDFKit.PDFDocument,
    title: string,
    text: string,
  ): void {
    this.ensureSectionSpace(document, text);
    this.renderSectionHeading(document, title);
    document
      .moveDown(0.5)
      .font('NotoSans')
      .fontSize(10.5)
      .fillColor(COLORS.text)
      .text(text, { lineGap: 2.5 });
  }

  private renderSectionHeading(
    document: PDFKit.PDFDocument,
    title: string,
  ): void {
    document
      .moveDown(1.1)
      .font('NotoSansBold')
      .fontSize(16)
      .fillColor(COLORS.text)
      .text(title, { lineGap: 1 });
    const dividerY = document.y + 5;
    document
      .strokeColor(COLORS.divider)
      .lineWidth(0.7)
      .moveTo(PAGE_MARGIN_X, dividerY)
      .lineTo(document.page.width - PAGE_MARGIN_X, dividerY)
      .stroke();
    document.y = dividerY + 4;
  }

  private ensureSectionSpace(
    document: PDFKit.PDFDocument,
    firstContent: string,
  ): void {
    document.font('NotoSans').fontSize(10.5);
    const firstContentHeight = document.heightOfString(firstContent, {
      width: this.contentWidth(document),
      lineGap: 2.5,
    });
    const requiredHeight = 66 + Math.min(firstContentHeight, 68);
    this.ensureSpace(document, requiredHeight);
  }

  private renderGallery(
    document: PDFKit.PDFDocument,
    images: PdfImage[],
  ): void {
    if (images.length === 0) {
      return;
    }
    const columns = galleryColumnCount(images.length);
    const contentWidth = this.contentWidth(document);
    const cellWidth =
      columns === 1
        ? Math.min(contentWidth, SINGLE_IMAGE_MAX_WIDTH)
        : (contentWidth - GALLERY_GAP) / 2;
    const maximumHeight =
      columns === 1 ? SINGLE_IMAGE_MAX_HEIGHT : GRID_IMAGE_MAX_HEIGHT;
    document.moveDown(0.9);

    for (let index = 0; index < images.length; index += columns) {
      const row = images.slice(index, index + columns).map((image) => {
        const buffer = Buffer.from(image.bytes);
        const source = (document as PdfDocumentWithImageDimensions).openImage(
          buffer,
        );
        return {
          buffer,
          dimensions: fitImageDimensions(
            source.width,
            source.height,
            cellWidth,
            maximumHeight,
          ),
        };
      });
      const rowHeight = Math.max(
        ...row.map((image) => image.dimensions.height),
      );
      this.ensureSpace(document, rowHeight + GALLERY_GAP);
      const rowTop = document.y;
      const rowWidth = columns * cellWidth + (columns - 1) * GALLERY_GAP;
      const rowLeft = PAGE_MARGIN_X + (contentWidth - rowWidth) / 2;

      row.forEach((image, columnIndex) => {
        const cellLeft = rowLeft + columnIndex * (cellWidth + GALLERY_GAP);
        const imageX = cellLeft + (cellWidth - image.dimensions.width) / 2;
        const imageY = rowTop + (rowHeight - image.dimensions.height) / 2;
        document.image(image.buffer, imageX, imageY, {
          width: image.dimensions.width,
          height: image.dimensions.height,
        });
      });
      document.y = rowTop + rowHeight + GALLERY_GAP;
    }
  }

  private renderPageChrome(
    document: PDFKit.PDFDocument,
    range: { start: number; count: number },
    reportTitle: string,
  ): void {
    for (let index = 0; index < range.count; index += 1) {
      document.switchToPage(range.start + index);
      document.page.margins.bottom = 0;
      if (index > 0) {
        document
          .font('NotoSans')
          .fontSize(8)
          .fillColor(COLORS.muted)
          .text(reportTitle, PAGE_MARGIN_X, 28, {
            width: this.contentWidth(document),
            align: 'right',
            lineBreak: false,
            ellipsis: true,
          });
      }
      const footerY = document.page.height - FOOTER_Y_OFFSET;
      document
        .strokeColor(COLORS.divider)
        .lineWidth(0.6)
        .moveTo(PAGE_MARGIN_X, footerY - 8)
        .lineTo(document.page.width - PAGE_MARGIN_X, footerY - 8)
        .stroke();
      document
        .font('NotoSansBold')
        .fontSize(8.5)
        .fillColor(COLORS.muted)
        .text('FastRep', PAGE_MARGIN_X, footerY, {
          width: this.contentWidth(document) / 2,
          lineBreak: false,
        });
      document
        .font('NotoSans')
        .text(
          `${index + 1} / ${range.count}`,
          PAGE_MARGIN_X + this.contentWidth(document) / 2,
          footerY,
          {
            width: this.contentWidth(document) / 2,
            align: 'right',
            lineBreak: false,
          },
        );
    }
  }

  private ensureSpace(document: PDFKit.PDFDocument, points: number): void {
    const contentBottom = document.page.height - PAGE_MARGIN_BOTTOM;
    if (needsPageBreak(document.y, points, contentBottom)) {
      document.addPage();
    }
  }

  private contentWidth(document: PDFKit.PDFDocument): number {
    return document.page.width - PAGE_MARGIN_X * 2;
  }

  private resolveFont(fileName: string): string | undefined {
    const candidates = fontPathCandidates(__dirname, process.cwd(), fileName);
    return candidates.find((candidate) => existsSync(candidate));
  }

  private labels(language: string): ReportLabels {
    const labels = {
      en: {
        generated: 'Generated',
        summary: 'Executive Summary',
        conclusion: 'Conclusion',
        recommendations: 'Recommendations',
        photograph: 'photograph',
      },
      uk: {
        generated: 'Створено',
        summary: 'Резюме',
        conclusion: 'Висновок',
        recommendations: 'Рекомендації',
        photograph: 'фотографія',
      },
      de: {
        generated: 'Erstellt',
        summary: 'Zusammenfassung',
        conclusion: 'Fazit',
        recommendations: 'Empfehlungen',
        photograph: 'Foto',
      },
      fr: {
        generated: 'Généré',
        summary: 'Résumé',
        conclusion: 'Conclusion',
        recommendations: 'Recommandations',
        photograph: 'photographie',
      },
      es: {
        generated: 'Generado',
        summary: 'Resumen ejecutivo',
        conclusion: 'Conclusión',
        recommendations: 'Recomendaciones',
        photograph: 'fotografía',
      },
    };
    return labels[language as keyof typeof labels] ?? labels.en;
  }
}
