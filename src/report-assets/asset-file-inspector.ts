import { ReportAssetType } from '../../generated/prisma/client';

export type AssetInspection = {
  mimeType: string;
  type: ReportAssetType;
  width?: number;
  height?: number;
  durationSeconds?: number;
};

const JPEG_MIME = 'image/jpeg';
const PNG_MIME = 'image/png';
const WEBP_MIME = 'image/webp';

export const inspectAssetBytes = (
  bytes: Uint8Array,
  objectSize: number,
): AssetInspection | null => {
  if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) {
    const dimensions = readJpegDimensions(bytes);
    return {
      mimeType: JPEG_MIME,
      type: ReportAssetType.IMAGE,
      ...dimensions,
    };
  }

  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return {
      mimeType: PNG_MIME,
      type: ReportAssetType.IMAGE,
      width: readUint32Be(bytes, 16),
      height: readUint32Be(bytes, 20),
    };
  }

  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const dimensions = readWebpDimensions(bytes);
    return {
      mimeType: WEBP_MIME,
      type: ReportAssetType.IMAGE,
      ...dimensions,
    };
  }

  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') {
    return {
      mimeType: 'audio/wav',
      type: ReportAssetType.AUDIO,
      durationSeconds: readWavDuration(bytes, objectSize),
    };
  }

  if (isMp3(bytes)) {
    return {
      mimeType: 'audio/mpeg',
      type: ReportAssetType.AUDIO,
      durationSeconds: readMp3Duration(bytes, objectSize),
    };
  }

  if (isM4a(bytes)) {
    return {
      mimeType: 'audio/x-m4a',
      type: ReportAssetType.AUDIO,
      durationSeconds: readMp4Duration(bytes),
    };
  }

  if (ascii(bytes, 0, 5) === '%PDF-') {
    return {
      mimeType: 'application/pdf',
      type: ReportAssetType.DOCUMENT,
    };
  }

  if (
    hasPrefix(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    hasPrefix(bytes, [0x50, 0x4b, 0x05, 0x06])
  ) {
    const archiveText = new TextDecoder('latin1').decode(bytes);

    if (archiveText.includes('word/')) {
      return {
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        type: ReportAssetType.DOCUMENT,
      };
    }

    if (archiveText.includes('xl/')) {
      return {
        mimeType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        type: ReportAssetType.DOCUMENT,
      };
    }

    return null;
  }

  return inspectText(bytes);
};

const inspectText = (bytes: Uint8Array): AssetInspection | null => {
  if (bytes.length === 0 || bytes.includes(0)) {
    return null;
  }

  let text: string;

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }

  const invalidControlCount = [...text].filter((character) => {
    const code = character.charCodeAt(0);
    return code < 32 && !['\t', '\n', '\r'].includes(character);
  }).length;

  if (invalidControlCount > 0) {
    return null;
  }

  const nonEmptyLines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const csv =
    nonEmptyLines.length > 0 &&
    nonEmptyLines.every((line) => line.includes(','));

  return {
    mimeType: csv ? 'text/csv' : 'text/plain',
    type: ReportAssetType.DOCUMENT,
  };
};

const readJpegDimensions = (
  bytes: Uint8Array,
): Pick<AssetInspection, 'width' | 'height'> => {
  let offset = 2;

  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }

    const length = readUint16Be(bytes, offset + 2);
    if (length < 2 || offset + length + 2 > bytes.length) {
      break;
    }

    if (
      marker !== undefined &&
      ((marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf))
    ) {
      return {
        height: readUint16Be(bytes, offset + 5),
        width: readUint16Be(bytes, offset + 7),
      };
    }

    offset += length + 2;
  }

  return {};
};

const readWebpDimensions = (
  bytes: Uint8Array,
): Pick<AssetInspection, 'width' | 'height'> => {
  const chunk = ascii(bytes, 12, 4);

  if (chunk === 'VP8X' && bytes.length >= 30) {
    return {
      width: 1 + readUint24Le(bytes, 24),
      height: 1 + readUint24Le(bytes, 27),
    };
  }

  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const packed = readUint32Le(bytes, 21);
    return {
      width: (packed & 0x3fff) + 1,
      height: ((packed >>> 14) & 0x3fff) + 1,
    };
  }

  if (
    chunk === 'VP8 ' &&
    bytes.length >= 30 &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    return {
      width: readUint16Le(bytes, 26) & 0x3fff,
      height: readUint16Le(bytes, 28) & 0x3fff,
    };
  }

  return {};
};

const readWavDuration = (
  bytes: Uint8Array,
  objectSize: number,
): number | undefined => {
  let offset = 12;
  let byteRate: number | undefined;
  let dataSize: number | undefined;

  while (offset + 8 <= bytes.length) {
    const chunkId = ascii(bytes, offset, 4);
    const chunkSize = readUint32Le(bytes, offset + 4);

    if (chunkId === 'fmt ' && offset + 16 <= bytes.length) {
      byteRate = readUint32Le(bytes, offset + 12);
    } else if (chunkId === 'data') {
      dataSize = Math.min(chunkSize, objectSize - offset - 8);
      break;
    }

    offset += 8 + chunkSize + (chunkSize % 2);
  }

  return byteRate && dataSize !== undefined ? dataSize / byteRate : undefined;
};

const isMp3 = (bytes: Uint8Array): boolean =>
  ascii(bytes, 0, 3) === 'ID3' ||
  (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);

const readMp3Duration = (
  bytes: Uint8Array,
  objectSize: number,
): number | undefined => {
  let offset = ascii(bytes, 0, 3) === 'ID3' ? 10 + readSynchsafe(bytes, 6) : 0;

  while (offset + 4 <= bytes.length) {
    if (bytes[offset] === 0xff && (bytes[offset + 1] & 0xe0) === 0xe0) {
      const version = (bytes[offset + 1] >> 3) & 0x03;
      const layer = (bytes[offset + 1] >> 1) & 0x03;
      const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0f;
      const bitrates =
        version === 3 && layer === 1
          ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
          : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
      const kilobitsPerSecond = bitrates[bitrateIndex];
      return kilobitsPerSecond
        ? (objectSize * 8) / (kilobitsPerSecond * 1000)
        : undefined;
    }

    offset += 1;
  }

  return undefined;
};

const isM4a = (bytes: Uint8Array): boolean => {
  if (bytes.length < 16 || ascii(bytes, 4, 4) !== 'ftyp') {
    return false;
  }

  const audioBrands = new Set(['M4A ', 'M4B ', 'M4P ']);
  const boxSize = Math.min(readUint32Be(bytes, 0), bytes.length);
  if (audioBrands.has(ascii(bytes, 8, 4))) {
    return true;
  }

  for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
    if (audioBrands.has(ascii(bytes, offset, 4))) {
      return true;
    }
  }

  return false;
};

const readMp4Duration = (bytes: Uint8Array): number | undefined => {
  const marker = findAscii(bytes, 'mvhd');
  if (marker < 0 || marker + 24 >= bytes.length) {
    return undefined;
  }

  const version = bytes[marker + 4];
  const timescaleOffset = version === 1 ? marker + 24 : marker + 16;
  const durationOffset = version === 1 ? marker + 28 : marker + 20;
  const timescale = readUint32Be(bytes, timescaleOffset);

  if (!timescale) {
    return undefined;
  }

  if (version === 1) {
    const high = readUint32Be(bytes, durationOffset);
    const low = readUint32Be(bytes, durationOffset + 4);
    return (high * 2 ** 32 + low) / timescale;
  }

  return readUint32Be(bytes, durationOffset) / timescale;
};

const hasPrefix = (bytes: Uint8Array, prefix: number[]): boolean =>
  prefix.every((byte, index) => bytes[index] === byte);

const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.slice(offset, offset + length));

const findAscii = (bytes: Uint8Array, value: string): number =>
  new TextDecoder('latin1').decode(bytes).indexOf(value);

const readUint16Be = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);

const readUint16Le = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);

const readUint24Le = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) |
  ((bytes[offset + 1] ?? 0) << 8) |
  ((bytes[offset + 2] ?? 0) << 16);

const readUint32Be = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) * 2 ** 24 +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)) >>>
  0;

const readUint32Le = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)) >>>
  0;

const readSynchsafe = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) << 21) |
  ((bytes[offset + 1] ?? 0) << 14) |
  ((bytes[offset + 2] ?? 0) << 7) |
  (bytes[offset + 3] ?? 0);
