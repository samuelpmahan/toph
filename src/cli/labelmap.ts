// A component label map stored run-length-encoded. Query semantics live here; raster
// encoding/persistence remains outside the runtime hot path.

export interface LabelmapDocument {
	assetId: number;
	widthPx: number;
	heightPx: number;
	encoding: 'rle';
	/** Named coordinate frame for this raster. New truth fixtures should always provide
	 * this; old fixtures without spaces remain readable for compatibility. */
	space?: string;
	/** Ordered entity set labeled by pixel values: label N resolves to entityIds[N-1].
	 * This removes the old unsafe assumption that entity ordinal is globally unique. */
	entityIds?: number[];
	/** [value, runLength] pairs in row-major order, covering exactly widthPx*heightPx. */
	runs: Array<[number, number]>;
}

export function decodeLabelmap(doc: LabelmapDocument): Uint32Array {
	const pixelCount = doc.widthPx * doc.heightPx;
	const out = new Uint32Array(pixelCount);
	let cursor = 0;
	for (const [value, count] of doc.runs) {
		if (!Number.isInteger(value) || value < 0 || !Number.isInteger(count) || count < 0) {
			throw new Error('toph: labelmap RLE values and run lengths must be non-negative integers.');
		}
		if (cursor + count > pixelCount) {
			throw new Error(`toph: labelmap RLE runs exceed widthPx*heightPx = ${pixelCount}. Corrupt or mismatched labelmap document.`);
		}
		out.fill(value, cursor, cursor + count);
		cursor += count;
	}
	if (cursor !== pixelCount) {
		throw new Error(`toph: labelmap RLE runs cover ${cursor} pixels, expected widthPx*heightPx = ${pixelCount}. Corrupt or mismatched labelmap document.`);
	}
	return out;
}

export function labelAt(decoded: Uint32Array, widthPx: number, heightPx: number, x: number, y: number): number {
	if (x < 0 || y < 0 || x >= widthPx || y >= heightPx) {
		throw new Error(`toph: labelAt(${x}, ${y}) is out of bounds for a ${widthPx}x${heightPx} labelmap.`);
	}
	return decoded[y * widthPx + x];
}