/**
 * imageProcessing.ts
 *
 * Helpers for resizing and cropping images before they hit the vision API.
 * Uses Canvas + createImageBitmap, which work in Obsidian's Electron and
 * mobile webview environments without external deps.
 */

/**
 * Anthropic recommends keeping the longest edge at or below this value to avoid
 * server-side downscaling. See https://docs.claude.com/en/docs/build-with-claude/vision
 */
export const MAX_EDGE_PX = 1568;

export interface ResizedImage {
	/** The resized file, ready to upload. */
	file: File;
	/** Width and height of the resized image, in pixels. */
	width: number;
	height: number;
	/** Width and height of the original (pre-resize) image, in pixels. */
	originalWidth: number;
	originalHeight: number;
	/** "image/png" or "image/jpeg". */
	mimeType: string;
}

/**
 * Resizes the image so that its longest edge is at most maxEdge pixels.
 * If the image is already smaller, returns the original bytes (re-wrapped) and original dims.
 *
 * Outputs PNG by default to avoid JPEG compression smearing thin diagram lines.
 * Pass mimeType: "image/jpeg" if you want a smaller payload and don't care about line crispness.
 */
export async function resizeImageForVision(
	file: File,
	options: { maxEdge?: number; mimeType?: "image/png" | "image/jpeg"; quality?: number } = {},
): Promise<ResizedImage> {
	const maxEdge = options.maxEdge ?? MAX_EDGE_PX;
	const mimeType = options.mimeType ?? "image/png";
	const quality = options.quality ?? 0.92;

	const bitmap = await createImageBitmap(file);
	const originalWidth = bitmap.width;
	const originalHeight = bitmap.height;

	const longestEdge = Math.max(originalWidth, originalHeight);
	const scale = longestEdge > maxEdge ? maxEdge / longestEdge : 1;
	const targetWidth = Math.round(originalWidth * scale);
	const targetHeight = Math.round(originalHeight * scale);

	// No resize needed: still re-encode through canvas if the caller asked for a different
	// mime type, otherwise return the original file as-is.
	if (scale === 1 && file.type === mimeType) {
		bitmap.close?.();
		return {
			file,
			width: targetWidth,
			height: targetHeight,
			originalWidth,
			originalHeight,
			mimeType: file.type,
		};
	}

	const canvas = document.createElement("canvas");
	canvas.width = targetWidth;
	canvas.height = targetHeight;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		bitmap.close?.();
		throw new Error("Could not get a 2D canvas context for resizing.");
	}

	ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
	bitmap.close?.();

	const blob = await canvasToBlob(canvas, mimeType, quality);
	const resizedFile = new File([blob], renameWithExtension(file.name, mimeType), {
		type: mimeType,
	});

	return {
		file: resizedFile,
		width: targetWidth,
		height: targetHeight,
		originalWidth,
		originalHeight,
		mimeType,
	};
}

/**
 * Crops a region from an image File and returns it as a new File.
 * bbox is in pixel coords of the source File.
 */
export async function cropImage(
	file: File,
	bbox: { x: number; y: number; width: number; height: number },
	options: { mimeType?: "image/png" | "image/jpeg"; quality?: number; filenameSuffix?: string } = {},
): Promise<File> {
	const mimeType = options.mimeType ?? "image/png";
	const quality = options.quality ?? 0.92;
	const suffix = options.filenameSuffix ?? "crop";

	const bitmap = await createImageBitmap(file);
	const x = clamp(Math.round(bbox.x), 0, bitmap.width);
	const y = clamp(Math.round(bbox.y), 0, bitmap.height);
	const width = clamp(Math.round(bbox.width), 1, bitmap.width - x);
	const height = clamp(Math.round(bbox.height), 1, bitmap.height - y);

	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		bitmap.close?.();
		throw new Error("Could not get a 2D canvas context for cropping.");
	}

	ctx.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
	bitmap.close?.();

	const blob = await canvasToBlob(canvas, mimeType, quality);
	const baseName = file.name.replace(/\.[^/.]+$/, "");
	return new File([blob], renameWithExtension(`${baseName}-${suffix}`, mimeType), {
		type: mimeType,
	});
}

/**
 * Converts a normalized 0-1000 bbox (as Anthropic vision models prefer to emit)
 * into pixel coords for an image of the given dimensions.
 *
 * Defensively clamps the input to [0, normalizationScale] before mapping. LLM
 * output is not guaranteed to honor the schema bounds; we have observed values
 * like x_max=1050 in practice. Without clamping these produce bboxes wider than
 * the image and the overlay renders as a single visible edge.
 */
export function denormalizeBbox(
	bbox: { x_min: number; y_min: number; x_max: number; y_max: number },
	imageWidth: number,
	imageHeight: number,
	normalizationScale = 1000,
): { x: number; y: number; width: number; height: number } {
	const xMin = clamp(bbox.x_min, 0, normalizationScale);
	const yMin = clamp(bbox.y_min, 0, normalizationScale);
	const xMax = clamp(bbox.x_max, 0, normalizationScale);
	const yMax = clamp(bbox.y_max, 0, normalizationScale);

	const x = (xMin / normalizationScale) * imageWidth;
	const y = (yMin / normalizationScale) * imageHeight;
	const w = ((xMax - xMin) / normalizationScale) * imageWidth;
	const h = ((yMax - yMin) / normalizationScale) * imageHeight;
	return { x, y, width: w, height: h };
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (blob) {
					resolve(blob);
				} else {
					reject(new Error("Canvas toBlob returned null."));
				}
			},
			type,
			quality,
		);
	});
}

function renameWithExtension(name: string, mimeType: string): string {
	const base = name.replace(/\.[^/.]+$/, "");
	const ext = mimeType === "image/jpeg" ? "jpg" : "png";
	return `${base}.${ext}`;
}

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}