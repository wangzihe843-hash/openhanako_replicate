import fs from 'node:fs';
import zlib from 'node:zlib';
import pngjs from 'pngjs';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_BYTES = 80 * 1024 * 1024;
const MAX_CARD_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_777_216;
const MAX_CHUNKS = 100_000;

export class SillyTavernPngError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SillyTavernPngError';
  }
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeCardText(raw: Buffer, keyword: string): unknown {
  if (!raw.length || raw.length > MAX_CARD_TEXT_BYTES || raw.length % 4 !== 0) {
    throw new SillyTavernPngError(`Invalid ${keyword} metadata length`);
  }
  const encoded = raw.toString('latin1');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new SillyTavernPngError(`Invalid ${keyword} metadata encoding`);
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length > MAX_CARD_TEXT_BYTES || decoded.toString('base64') !== encoded) {
    throw new SillyTavernPngError(`Invalid ${keyword} metadata encoding`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  } catch {
    throw new SillyTavernPngError(`Invalid ${keyword} metadata UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SillyTavernPngError(`Invalid ${keyword} metadata JSON`);
  }
}

/** Read the ST tEXt card payload without changing or exporting the source image. */
export function parseSillyTavernPng(buffer: Buffer): { card: unknown; keyword: 'chara' | 'ccv3' } {
  if (buffer.length < PNG_SIGNATURE.length + 12 || buffer.length > MAX_PNG_BYTES
      || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new SillyTavernPngError('Invalid PNG signature or size');
  }
  let offset = PNG_SIGNATURE.length;
  let chunks = 0;
  let seenHeader = false;
  let seenImageData = false;
  let imageDataEnded = false;
  let seenEnd = false;
  let imageHeight = 0;
  const idatChunks: Buffer[] = [];
  const cardTexts = new Map<'chara' | 'ccv3', Buffer>();
  while (offset < buffer.length) {
    if (++chunks > MAX_CHUNKS || buffer.length - offset < 12) {
      throw new SillyTavernPngError('Truncated PNG chunk');
    }
    const length = buffer.readUInt32BE(offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    if (length > buffer.length - dataOffset - 4) {
      throw new SillyTavernPngError('Truncated PNG chunk');
    }
    const dataEnd = dataOffset + length;
    const type = buffer.toString('ascii', typeOffset, dataOffset);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(buffer.subarray(typeOffset, dataEnd)) !== buffer.readUInt32BE(dataEnd)) {
      throw new SillyTavernPngError(`Invalid PNG chunk ${type}`);
    }
    if (!seenHeader && type !== 'IHDR') throw new SillyTavernPngError('PNG header is missing');
    if (seenImageData && type !== 'IDAT') imageDataEnded = true;
    if (type === 'IHDR') {
      if (seenHeader || length !== 13) throw new SillyTavernPngError('Invalid PNG header');
      const width = buffer.readUInt32BE(dataOffset);
      const height = buffer.readUInt32BE(dataOffset + 4);
      if (!width || !height || width * height > MAX_IMAGE_PIXELS) {
        throw new SillyTavernPngError('PNG image dimensions are unsupported');
      }
      seenHeader = true;
      imageHeight = height;
    } else if (type === 'IDAT') {
      if (imageDataEnded) throw new SillyTavernPngError('PNG image data chunks are not consecutive');
      seenImageData = true;
      idatChunks.push(buffer.subarray(dataOffset, dataEnd));
    } else if (type === 'tEXt') {
      const data = buffer.subarray(dataOffset, dataEnd);
      const separator = data.indexOf(0);
      if (separator < 1 || separator > 79) throw new SillyTavernPngError('Invalid PNG text chunk keyword');
      const keyword = data.toString('latin1', 0, separator).toLowerCase();
      if (keyword === 'chara' || keyword === 'ccv3') {
        if (cardTexts.has(keyword)) throw new SillyTavernPngError(`Duplicate ${keyword} metadata`);
        const value = data.subarray(separator + 1);
        if (value.length > MAX_CARD_TEXT_BYTES) throw new SillyTavernPngError(`${keyword} metadata is too large`);
        cardTexts.set(keyword, value);
      }
    } else if (type === 'IEND') {
      if (length !== 0 || !seenImageData || dataEnd + 4 !== buffer.length) {
        throw new SillyTavernPngError('Invalid PNG end or image data');
      }
      seenEnd = true;
      break;
    }
    offset = dataEnd + 4;
  }
  if (!seenEnd) throw new SillyTavernPngError('PNG end is missing');
  const keyword = cardTexts.has('ccv3') ? 'ccv3' : 'chara';
  const raw = cardTexts.get(keyword);
  if (!raw) throw new SillyTavernPngError('PNG has no chara or ccv3 character metadata');
  // Metadata can be sound while the portrait is damaged. Validate the raster too.
  try {
    // pngjs may return a partial image for an invalid compressed stream. Check zlib explicitly.
    zlib.inflateSync(Buffer.concat(idatChunks), { maxOutputLength: MAX_IMAGE_PIXELS * 9 + imageHeight * 7 });
    pngjs.PNG.sync.read(buffer, { checkCRC: true });
  } catch {
    throw new SillyTavernPngError('PNG portrait data is damaged or unsupported');
  }
  return { card: decodeCardText(raw, keyword), keyword };
}

export function readSillyTavernPng(filePath: string): { card: unknown; keyword: 'chara' | 'ccv3' } {
  if (fs.statSync(filePath).size > MAX_PNG_BYTES) throw new SillyTavernPngError('PNG card is too large');
  return parseSillyTavernPng(fs.readFileSync(filePath));
}

/** Remove embedded character cards from an exported image without recompressing its pixels. */
export function stripSillyTavernPngCharacterMetadata(buffer: Buffer): Buffer {
  if (buffer.length < PNG_SIGNATURE.length + 12 || buffer.length > MAX_PNG_BYTES
      || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new SillyTavernPngError('Invalid PNG signature or size');
  }
  const retained: Buffer[] = [buffer.subarray(0, PNG_SIGNATURE.length)];
  let offset = PNG_SIGNATURE.length;
  let chunks = 0;
  let seenHeader = false;
  let seenEnd = false;
  let removed = false;
  while (offset < buffer.length) {
    if (++chunks > MAX_CHUNKS || buffer.length - offset < 12) {
      throw new SillyTavernPngError('Truncated PNG chunk');
    }
    const length = buffer.readUInt32BE(offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    if (length > buffer.length - dataOffset - 4) {
      throw new SillyTavernPngError('Truncated PNG chunk');
    }
    const dataEnd = dataOffset + length;
    const nextOffset = dataEnd + 4;
    const type = buffer.toString('ascii', typeOffset, dataOffset);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(buffer.subarray(typeOffset, dataEnd)) !== buffer.readUInt32BE(dataEnd)) {
      throw new SillyTavernPngError(`Invalid PNG chunk ${type}`);
    }
    if (!seenHeader && type !== 'IHDR') throw new SillyTavernPngError('PNG header is missing');
    if (type === 'IHDR') {
      if (seenHeader || length !== 13) throw new SillyTavernPngError('Invalid PNG header');
      seenHeader = true;
    }
    const isText = type === 'tEXt' || type === 'zTXt' || type === 'iTXt';
    const separator = isText ? buffer.indexOf(0, dataOffset) : -1;
    const keyword = separator >= dataOffset && separator < dataEnd
      ? buffer.toString('latin1', dataOffset, separator).toLowerCase() : '';
    if (keyword === 'chara' || keyword === 'ccv3') {
      removed = true;
    } else {
      retained.push(buffer.subarray(offset, nextOffset));
    }
    if (type === 'IEND') {
      if (length !== 0 || nextOffset !== buffer.length) throw new SillyTavernPngError('Invalid PNG end');
      seenEnd = true;
      break;
    }
    offset = nextOffset;
  }
  if (!seenEnd) throw new SillyTavernPngError('PNG end is missing');
  return removed ? Buffer.concat(retained) : buffer;
}
