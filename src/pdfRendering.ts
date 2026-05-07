/**
 * pdfRendering.ts
 *
 * Render PDF pages to PNG files in-browser using Obsidian's bundled PDF.js.
 * The diagram pipeline works on images, so scanned/handwritten PDFs need this
 * bridge before we can run bbox detection and crop the original drawing.
 */

import { loadPdfJs } from "obsidian";
import { MAX_EDGE_PX } from "./imageProcessing";

export interface RenderedPdfPage {
	file: File;
	pageNumber: number;
	width: number;
	height: number;
}

export async function renderPdfPagesToImages(
	file: File,
	options: { maxEdge?: number } = {},
): Promise<RenderedPdfPage[]> {
	const maxEdge = options.maxEdge ?? MAX_EDGE_PX;
	const pdfjsLib = await loadPdfJs();
	const bytes = new Uint8Array(await file.arrayBuffer());
	const loadingTask = pdfjsLib.getDocument({ data: bytes });
	const pdf = await loadingTask.promise;
	const pages: RenderedPdfPage[] = [];

	try {
		for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
			const page = await pdf.getPage(pageNumber);
			const unitViewport = page.getViewport({ scale: 1 });
			const longestEdge = Math.max(unitViewport.width, unitViewport.height);
			const scale = longestEdge > 0 ? maxEdge / longestEdge : 1;
			const viewport = page.getViewport({ scale });

			const canvas = document.createElement("canvas");
			canvas.width = Math.ceil(viewport.width);
			canvas.height = Math.ceil(viewport.height);
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				throw new Error("Could not get a 2D canvas context for PDF rendering.");
			}

			await page.render({ canvasContext: ctx, viewport }).promise;
			const blob = await canvasToBlob(canvas, "image/png");
			const baseName = file.name.replace(/\.[^/.]+$/, "");
			pages.push({
				file: new File([blob], `${baseName}-page-${pageNumber}.png`, { type: "image/png" }),
				pageNumber,
				width: canvas.width,
				height: canvas.height,
			});

			page.cleanup?.();
		}
	} finally {
		pdf.cleanup?.();
		pdf.destroy?.();
	}

	return pages;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => {
			if (blob) {
				resolve(blob);
			} else {
				reject(new Error("Canvas toBlob returned null."));
			}
		}, type);
	});
}
