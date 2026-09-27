import { describe, expect, it } from 'vitest';
import pngjs from 'pngjs';
import { parseSillyTavernPng, stripSillyTavernPngCharacterMetadata } from '../lib/character-cards/sillytavern-png.ts';

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, check]);
}

function pngWithCard(chunks: Array<[string, string]>): Buffer {
  const png = new pngjs.PNG({ width: 1, height: 1 });
  png.data.set([15, 30, 45, 255]);
  const image = pngjs.PNG.sync.write(png);
  const texts = chunks.map(([keyword, payload]) => chunk('tEXt', Buffer.concat([
    Buffer.from(`${keyword}\0`, 'latin1'), Buffer.from(payload, 'utf8'),
  ])));
  return Buffer.concat([image.subarray(0, -12), ...texts, image.subarray(-12)]);
}

const v2 = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Old' } };
const v3 = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Current' } };
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');

describe('SillyTavern PNG container', () => {
  it('reads V2 chara and gives valid ccv3 precedence over a V2 shadow', () => {
    expect(parseSillyTavernPng(pngWithCard([['chara', encoded(v2)]])).card).toEqual(v2);
    const result = parseSillyTavernPng(pngWithCard([['chara', encoded(v2)], ['ccv3', encoded(v3)]]));
    expect(result).toEqual({ card: v3, keyword: 'ccv3' });
  });

  it('rejects malformed or ambiguous metadata without silently using an older shadow', () => {
    expect(() => parseSillyTavernPng(pngWithCard([]))).toThrow('no chara or ccv3');
    expect(() => parseSillyTavernPng(pngWithCard([['chara', encoded(v2)], ['ccv3', 'not-base64']]))).toThrow('ccv3 metadata');
    expect(() => parseSillyTavernPng(pngWithCard([['chara', encoded(v2)], ['chara', encoded(v2)]]))).toThrow('Duplicate chara');
    expect(() => parseSillyTavernPng(pngWithCard([['chara', Buffer.from('{').toString('base64')]]))).toThrow('metadata JSON');
    const valid = pngWithCard([['chara', encoded(v2)]]);
    const malformedText = Buffer.concat([valid.subarray(0, -12), chunk('tEXt', Buffer.from('ccv3')), valid.subarray(-12)]);
    expect(() => parseSillyTavernPng(malformedText)).toThrow('text chunk keyword');
  });

  it('rejects damaged chunks, missing end, false PNG signatures, and broken portrait data', () => {
    const valid = pngWithCard([['chara', encoded(v2)]]);
    const badCrc = Buffer.from(valid);
    badCrc[badCrc.length - 20] ^= 1;
    expect(() => parseSillyTavernPng(badCrc)).toThrow('Invalid PNG chunk');
    expect(() => parseSillyTavernPng(valid.subarray(0, -12))).toThrow('end is missing');
    expect(() => parseSillyTavernPng(Buffer.from('not a PNG'))).toThrow('PNG signature');
    const idat = valid.indexOf(Buffer.from('IDAT'));
    const damaged = Buffer.from(valid);
    damaged[idat + 4] = 0xff;
    const idatLength = damaged.readUInt32BE(idat - 4);
    damaged.writeUInt32BE(crc32(damaged.subarray(idat, idat + 4 + idatLength)), idat + 4 + idatLength);
    expect(() => parseSillyTavernPng(damaged)).toThrow('portrait data is damaged');
  });

  it('strips all embedded card metadata from an export while preserving image pixels and unrelated text', () => {
    const source = pngWithCard([['chara', encoded(v2)], ['ccv3', encoded(v3)], ['comment', 'keep this']]);
    const exported = stripSillyTavernPngCharacterMetadata(source);
    expect(exported).not.toEqual(source);
    expect(pngjs.PNG.sync.read(exported).data).toEqual(pngjs.PNG.sync.read(source).data);
    expect(exported.includes(Buffer.from('comment\0keep this'))).toBe(true);
    expect(() => parseSillyTavernPng(exported)).toThrow('no chara or ccv3');
    expect(stripSillyTavernPngCharacterMetadata(exported)).toBe(exported);
  });
});
