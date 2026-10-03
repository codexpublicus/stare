// Read and write PNG tEXt chunks, so og-image.png can record which
// og-image.svg it was rendered from (web/tests/collection.test.js).
import { crc32 } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunks(png) {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  const out = [];
  let at = 8;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    out.push({ type, start: at, end: at + 12 + length, data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return out;
}

// { keyword: text } for every tEXt chunk.
export function pngTextChunks(png) {
  const text = {};
  for (const c of chunks(png)) {
    if (c.type !== 'tEXt') continue;
    const nul = c.data.indexOf(0);
    text[c.data.toString('latin1', 0, nul)] = c.data.toString('latin1', nul + 1);
  }
  return text;
}

// The PNG with a tEXt chunk for keyword set to value, just before IEND.
export function withPngText(png, keyword, value) {
  const kept = chunks(png).filter(
    (c) => !(c.type === 'tEXt' && c.data.toString('latin1', 0, c.data.indexOf(0)) === keyword),
  );
  const body = Buffer.concat([Buffer.from('tEXt', 'latin1'), Buffer.from(`${keyword}\0${value}`, 'latin1')]);
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(body.length - 4, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
  const iend = kept.findIndex((c) => c.type === 'IEND');
  return Buffer.concat([
    SIGNATURE,
    ...kept.slice(0, iend).map((c) => png.subarray(c.start, c.end)),
    chunk,
    ...kept.slice(iend).map((c) => png.subarray(c.start, c.end)),
  ]);
}
