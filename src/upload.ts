import { TFile } from "obsidian";

const IMAGE_EXTENSIONS = [".bmp", ".gif", ".heic", ".heif", ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"];

export function getUploadSelectionError(files: File[]): string | null {
	if (files.length === 0) {
		return null;
	}

	const pdfCount = files.filter((file) => isPdfUpload(file)).length;
	const imageCount = files.filter((file) => isImageUpload(file)).length;

	if (pdfCount + imageCount !== files.length) {
		return "Unsupported file type. Choose one PDF or one or more images.";
	}

	if (pdfCount > 0 && imageCount > 0) {
		return "Choose either one PDF or one or more images, not both together.";
	}

	if (pdfCount > 1) {
		return "Choose a single PDF or one or more images.";
	}

	return null;
}

export function isPdfUpload(file: File): boolean {
	const lowerName = file.name.toLowerCase();
	const lowerType = file.type.toLowerCase();
	return lowerType === "application/pdf" || lowerName.endsWith(".pdf");
}

export function isImageUpload(file: File): boolean {
	const lowerName = file.name.toLowerCase();
	const lowerType = file.type.toLowerCase();
	return lowerType.startsWith("image/")
		|| IMAGE_EXTENSIONS.some((extension) => lowerName.endsWith(extension));
}

export function isSupportedCapturedImage(file: TFile): boolean {
	return Boolean(getMimeTypeFromExtension(file.extension));
}

export function getMimeTypeFromExtension(extension: string): string {
	const normalizedExtension = extension.toLowerCase();
	switch (normalizedExtension) {
		case "bmp":
			return "image/bmp";
		case "gif":
			return "image/gif";
		case "heic":
			return "image/heic";
		case "heif":
			return "image/heif";
		case "jpeg":
		case "jpg":
			return "image/jpeg";
		case "png":
			return "image/png";
		case "tif":
		case "tiff":
			return "image/tiff";
		case "webp":
			return "image/webp";
		default:
			return "";
	}
}
