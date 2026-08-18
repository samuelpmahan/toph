/**
 * Minimal PNG encoder for test fixtures.
 * Produces valid PNG files with no external dependencies (only node:zlib).
 * Supports truecolor with alpha (RGBA, color type 6, bit depth 8).
 */

import { deflateSync } from 'node:zlib';

export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  // Validate input
  const expectedLength = width * height * 4;
  if (rgba.length !== expectedLength) {
    throw new Error(`Invalid RGBA length: expected ${expectedLength}, got ${rgba.length}`);
  }

  // PNG signature
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  // Create chunks
  const ihdr = createIHDRChunk(width, height);
  const idat = createIDATChunk(width, height, rgba);
  const iend = createIENDChunk();

  // Concatenate all chunks
  const result = new Uint8Array(signature.length + ihdr.length + idat.length + iend.length);
  let offset = 0;
  result.set(signature, offset);
  offset += signature.length;
  result.set(ihdr, offset);
  offset += ihdr.length;
  result.set(idat, offset);
  offset += idat.length;
  result.set(iend, offset);

  return result;
}

function createIHDRChunk(width: number, height: number): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);

  // Width (u32 BE)
  view.setUint32(0, width, false);
  // Height (u32 BE)
  view.setUint32(4, height, false);
  // Bit depth: 8
  data[8] = 8;
  // Color type: 6 (RGBA)
  data[9] = 6;
  // Compression method: 0
  data[10] = 0;
  // Filter method: 0
  data[11] = 0;
  // Interlace method: 0
  data[12] = 0;

  return createChunk('IHDR', data);
}

function createIDATChunk(width: number, height: number, rgba: Uint8Array): Uint8Array {
  // Prepare scanlines: each row is [0 (filter type), R,G,B,A, R,G,B,A, ...]
  const scanlines = new Uint8Array(height * (1 + width * 4));
  let pos = 0;

  for (let row = 0; row < height; row++) {
    scanlines[pos++] = 0; // Filter type: None
    const rowStart = row * width * 4;
    const rowEnd = rowStart + width * 4;
    scanlines.set(rgba.slice(rowStart, rowEnd), pos);
    pos += width * 4;
  }

  // Compress with zlib, level 9 for determinism
  const compressed = deflateSync(scanlines, { level: 9 });

  return createChunk('IDAT', compressed);
}

function createIENDChunk(): Uint8Array {
  return createChunk('IEND', new Uint8Array(0));
}

function createChunk(type: string, data: Uint8Array): Uint8Array {
  // Length (u32 BE)
  const length = new Uint8Array(4);
  const lengthView = new DataView(length.buffer);
  lengthView.setUint32(0, data.length, false);

  // Type (4 ASCII bytes)
  const typeBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    typeBytes[i] = type.charCodeAt(i);
  }

  // CRC computed over type + data
  const crcData = new Uint8Array(typeBytes.length + data.length);
  crcData.set(typeBytes, 0);
  crcData.set(data, typeBytes.length);

  const crc = crc32(crcData);
  const crcBytes = new Uint8Array(4);
  const crcView = new DataView(crcBytes.buffer);
  crcView.setUint32(0, crc, false);

  // Assemble chunk: length + type + data + crc
  const chunk = new Uint8Array(length.length + typeBytes.length + data.length + crcBytes.length);
  let pos = 0;
  chunk.set(length, pos);
  pos += length.length;
  chunk.set(typeBytes, pos);
  pos += typeBytes.length;
  chunk.set(data, pos);
  pos += data.length;
  chunk.set(crcBytes, pos);

  return chunk;
}

/**
 * CRC32 with standard PNG polynomial (0xEDB88320, reflected).
 * CRC is computed with initial value 0xFFFFFFFF and final XOR 0xFFFFFFFF.
 */
function crc32(data: Uint8Array): number {
  const table = new Uint32Array(256);

  // Build CRC32 lookup table
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[i] = crc >>> 0;
  }

  // Compute CRC
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }

  return (crc ^ 0xFFFFFFFF) >>> 0;
}
