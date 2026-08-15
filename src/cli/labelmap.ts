// A component label map, stored run-length-encoded (mostly-zero arrays -- a bright-mask
// labelmap on a full-resolution image is typically >95% background -- compress far
// better as RLE than as a raw per-pixel JSON array; see IMPLEMENTATION-DECISIONS.md
// section 8's note that Toph's core has no PNG encoder and shouldn't gain one. This is
// query-tool-only decoding, not part of the runtime/compiler's zero-cost path.

export interface LabelmapDocument {
	assetId: number;
	widthPx: number;
	heightPx: number;
	encoding: 'rle';
	/** [value, runLength] pairs, in row-major pixel order, covering exactly widthPx*heightPx pixels. */
	runs: Array<[number, number]>;
}

/** Decodes a LabelmapDocument into a flat, row-major Uint32Array of length widthPx*heightPx. */
export function decodeLabelmap(doc: LabelmapDocument): Uint32Array {
	const pixelCount = doc.widthPx * doc.heightPx;
	const out = new Uint32Array(pixelCount);
	let cursor = 0;
	for (const [value, count] of doc.runs) {
		out.fill(value, cursor, cursor + count);
		cursor += count;
	}
	if (cursor !== pixelCount) {
		throw new Error(
			`toph: labelmap RLE runs cover ${cursor} pixels, expected widthPx*heightPx = ${pixelCount}. Corrupt or mismatched labelmap document.`
		);
	}
	return out;
}

/** Looks up the label at pixel (x, y) in a decoded labelmap. 0 means "no component" (background). */
export function labelAt(decoded: Uint32Array, widthPx: number, heightPx: number, x: number, y: number): number {
	if (x < 0 || y < 0 || x >= widthPx || y >= heightPx) {
		throw new Error(`toph: labelAt(${x}, ${y}) is out of bounds for a ${widthPx}x${heightPx} labelmap.`);
	}
	return decoded[y * widthPx + x];
}
