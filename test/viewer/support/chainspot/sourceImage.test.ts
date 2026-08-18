import { describe, it, expect } from 'vitest';
import { renderCourseImage } from './sourceImage.js';
import { SCENE } from './scene.js';

describe('renderCourseImage', () => {
  it('renders a PNG with correct signature and size', () => {
    const png = renderCourseImage(SCENE);

    // Check PNG signature (8 bytes: 137, 80, 78, 71, 13, 10, 26, 10)
    const expectedSignature = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) {
      expect(png[i]).toBe(expectedSignature[i]);
    }

    // Check size > 1000 bytes
    expect(png.length).toBeGreaterThan(1000);
  });

  it('is deterministic (produces identical bytes on each call)', () => {
    const png1 = renderCourseImage(SCENE);
    const png2 = renderCourseImage(SCENE);

    // Same length
    expect(png2.length).toBe(png1.length);

    // Byte-for-byte identical
    expect(png2).toEqual(png1);
  });

  it('encodes correct width and height in IHDR chunk', () => {
    const png = renderCourseImage(SCENE);

    // PNG structure:
    // Bytes 0-7: signature
    // Bytes 8-11: IHDR chunk length (13)
    // Bytes 12-15: "IHDR"
    // Bytes 16-19: width (u32 BE)
    // Bytes 20-23: height (u32 BE)
    const view = new DataView(png.buffer, png.byteOffset);
    const width = view.getUint32(16, false); // big-endian
    const height = view.getUint32(20, false);

    expect(width).toBe(SCENE.widthPx);
    expect(height).toBe(SCENE.heightPx);
  });
});
