import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { encodePng } from './png';

describe('PNG encoder', () => {
  it('encodes a 3x2 image with correct structure', () => {
    const width = 3;
    const height = 2;

    // Create a simple test image: 3x2 pixels
    // Row 0: Red, Green, Blue
    // Row 1: White, Black, Transparent
    const rgba = new Uint8Array([
      // Row 0
      255, 0, 0, 255, // Red
      0, 255, 0, 255, // Green
      0, 0, 255, 255, // Blue
      // Row 1
      255, 255, 255, 255, // White
      0, 0, 0, 255, // Black
      0, 0, 0, 0, // Transparent
    ]);

    const png = encodePng(width, height, rgba);

    // Verify PNG signature (8 bytes)
    const signature = png.slice(0, 8);
    expect(signature).toEqual(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    );

    // Verify IHDR chunk
    const ihdrLengthView = new DataView(png.buffer, 8);
    const ihdrLength = ihdrLengthView.getUint32(0, false);
    expect(ihdrLength).toBe(13);

    // Verify IHDR type at bytes 12-15
    const ihdrType = String.fromCharCode(
      png[12],
      png[13],
      png[14],
      png[15]
    );
    expect(ihdrType).toBe('IHDR');

    // Verify width and height in IHDR data (bytes 16-28)
    const ihdrDataView = new DataView(png.buffer, 16);
    const decodedWidth = ihdrDataView.getUint32(0, false);
    const decodedHeight = ihdrDataView.getUint32(4, false);
    expect(decodedWidth).toBe(width);
    expect(decodedHeight).toBe(height);

    // Verify IEND chunk is at the end (last 12 bytes)
    const iendLengthView = new DataView(png.buffer, png.length - 12);
    const iendLength = iendLengthView.getUint32(0, false);
    expect(iendLength).toBe(0);

    const iendType = String.fromCharCode(
      png[png.length - 8],
      png[png.length - 7],
      png[png.length - 6],
      png[png.length - 5]
    );
    expect(iendType).toBe('IEND');

    const iendCrcView = new DataView(png.buffer, png.length - 4);
    const iendCrc = iendCrcView.getUint32(0, false);
    const expectedIendCrc = 0xAE426082;
    expect(iendCrc).toBe(expectedIendCrc);
  });

  it('round-trips IDAT data correctly', () => {
    const width = 3;
    const height = 2;
    const rgba = new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
      0, 0, 0, 255, 0, 0, 0, 0,
    ]);

    const png = encodePng(width, height, rgba);

    // Find IDAT chunk (after signature and IHDR)
    // Signature: 8 bytes
    // IHDR: 4 (length) + 4 (type) + 13 (data) + 4 (crc) = 25 bytes
    // IDAT starts at byte 33
    const idatLengthView = new DataView(png.buffer, 33);
    const idatLength = idatLengthView.getUint32(0, false);

    // IDAT data starts at byte 41 (33 + 4 length + 4 type)
    const idatData = png.slice(41, 41 + idatLength);

    // Decompress IDAT
    const inflated = inflateSync(idatData);

    // Verify length: height rows * (1 filter byte + width*4 pixel bytes)
    const expectedLength = height * (1 + width * 4);
    expect(inflated.length).toBe(expectedLength);

    // Verify filter type bytes (should be 0 for each row)
    for (let row = 0; row < height; row++) {
      const filterByte = inflated[row * (1 + width * 4)];
      expect(filterByte).toBe(0);
    }

    // Verify pixel data matches input
    let inflatedPos = 0;
    for (let row = 0; row < height; row++) {
      inflatedPos++; // skip filter byte
      const rowStart = row * width * 4;
      const rowEnd = rowStart + width * 4;
      const rowData = rgba.slice(rowStart, rowEnd);
      const inflatedRow = new Uint8Array(inflated.slice(inflatedPos, inflatedPos + width * 4));
      expect(Array.from(inflatedRow)).toEqual(Array.from(rowData));
      inflatedPos += width * 4;
    }
  });

  it('is deterministic', () => {
    const width = 4;
    const height = 3;
    const rgba = new Uint8Array(width * height * 4);

    // Fill with some pattern
    for (let i = 0; i < rgba.length; i++) {
      rgba[i] = (i * 13) & 0xFF;
    }

    const png1 = encodePng(width, height, rgba);
    const png2 = encodePng(width, height, rgba);

    expect(png1).toEqual(png2);
  });

  it('throws on mismatched RGBA length', () => {
    const width = 2;
    const height = 2;
    const rgba = new Uint8Array(10); // Wrong length (should be 16)

    expect(() => encodePng(width, height, rgba)).toThrow(
      /Invalid RGBA length/
    );
  });
});
