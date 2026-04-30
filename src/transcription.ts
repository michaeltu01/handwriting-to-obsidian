/**
 * transcription.ts
 * 
 * This file exports helper functions related to transcribing content from imported files.
 * It builds the content of the resulting Markdown files.
 */

import { arrayBufferToBase64, requestUrl } from "obsidian";
import type { HandwritingProvider } from "./settings";

export type SupportedUploadKind = "image" | "pdf";

interface ExtractionConfig {
	apiKey: string;
	provider: HandwritingProvider;
}

interface ImportedNoteContentOptions {
	importedAt: Date;
	includeOriginalDocument: boolean;
	markdown: string;
	provider: HandwritingProvider;
	sourceNames: string[];
	sourceType: SupportedUploadKind;
	title: string;
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
	bmp: "image/bmp",
	gif: "image/gif",
	heic: "image/heic",
	heif: "image/heif",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	tif: "image/tiff",
	tiff: "image/tiff",
	webp: "image/webp",
};

const OPENAI_MODEL = "gpt-4o-mini";
const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
const MAX_OUTPUT_TOKENS = 4096;

export async function extractMarkdownFromImages(
	files: File[],
	config: ExtractionConfig,
): Promise<{ kind: "image"; markdown: string }> {
	if (files.length === 0) {
		throw new Error("No images were provided.");
	}

	for (const file of files) {
		if (getUploadKind(file) !== "image") {
			throw new Error(`Unsupported file type for ${file.name}. Use image files only.`);
		}
	}

	const rawMarkdown = config.provider === "anthropic"
		? await transcribeImagesWithAnthropic(files, config.apiKey)
		: await transcribeImagesWithOpenAI(files, config.apiKey);

	const markdown = rawMarkdown.trim();
	if (!markdown) {
		throw new Error("The model returned an empty transcription.");
	}

	return { kind: "image", markdown };
}

export async function extractMarkdownFromFile(
	file: File,
	config: ExtractionConfig,
): Promise<{ kind: SupportedUploadKind; markdown: string }> {
	const kind = getUploadKind(file);
	if (kind === "image") {
		return await extractMarkdownFromImages([file], config);
	}

	const base64 = arrayBufferToBase64(await file.arrayBuffer());
	const rawMarkdown = config.provider === "anthropic"
		? await transcribeWithAnthropic(file, kind, base64, config.apiKey)
		: await transcribeWithOpenAI(file, kind, base64, config.apiKey);

	const markdown = rawMarkdown.trim();
	if (!markdown) {
		throw new Error("The model returned an empty transcription.");
	}

	return { kind, markdown };
}

export function inferNoteTitle(markdown: string, fallback: string): string {
	const trimmedMarkdown = markdown.trim();
	const headingMatch = trimmedMarkdown.match(/^#\s+(.+)$/m);
	if (headingMatch?.[1]) {
		return normalizeTitle(headingMatch[1], fallback);
	}

	const firstMeaningfulLine = trimmedMarkdown
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);

	if (firstMeaningfulLine) {
		return normalizeTitle(firstMeaningfulLine, fallback);
	}

	return normalizeTitle(fallback, "Imported note");
}

export function buildImportedNoteContent(options: ImportedNoteContentOptions): string {
	const markdown = options.markdown.trim();
	const title = normalizeTitle(options.title, "Imported note");
	const titleHeading = markdown.startsWith("#") ? "" : `# ${title}\n\n`;
	const sourceFilesFrontmatter = options.sourceNames.length === 1
		? [`source_file: '${escapeYamlString(options.sourceNames[0])}'`]
		: [
			"source_files:",
			...options.sourceNames.map((sourceName) => `  - '${escapeYamlString(sourceName)}'`),
		];

	const embeds = options.includeOriginalDocument && options.sourceNames.length > 0
		? ["", "---", "", "## Original Document", "", ...options.sourceNames.map((sourceName) => `![[${sourceName}]]`)]
		: [];

	return [
		"---",
		`title: '${escapeYamlString(title)}'`,
		...sourceFilesFrontmatter,
		`source_type: ${options.sourceType}`,
		`imported_at: ${options.importedAt.toISOString()}`,
		`llm_provider: ${options.provider}`,
		"---",
		"",
		`${titleHeading}${markdown}`.trim(),
		...embeds,
		"",
	].join("\n");
}

export function sanitizeFileNameSegment(value: string): string {
	return normalizeTitle(value, "Imported note")
		.replace(/[\\/:*?"<>|#[\]^]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
}

function getUploadKind(file: File): SupportedUploadKind {
	const lowerName = file.name.toLowerCase();
	const lowerType = file.type.toLowerCase();

	if (lowerType === "application/pdf" || lowerName.endsWith(".pdf")) {
		return "pdf";
	}

	if (lowerType.startsWith("image/")) {
		return "image";
	}

	if (Object.keys(IMAGE_MIME_BY_EXTENSION).some((extension) => lowerName.endsWith(`.${extension}`))) {
		return "image";
	}

	throw new Error(`Unsupported file type for ${file.name}. Use an image or PDF.`);
}

function getImageMediaType(file: File): string {
	if (file.type.startsWith("image/")) {
		return file.type;
	}

	const extension = file.name.toLowerCase().split(".").pop();
	if (extension && IMAGE_MIME_BY_EXTENSION[extension]) {
		return IMAGE_MIME_BY_EXTENSION[extension];
	}

	throw new Error(`Could not determine the image type for ${file.name}.`);
}

function normalizeTitle(candidate: string, fallback: string): string {
	const cleaned = candidate
		.replace(/^#+\s*/, "")
		.replace(/^[-*+]\s+/, "")
		.replace(/[_*`[\]]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);

	return cleaned || fallback;
}

function escapeYamlString(value: string): string {
	return value.replace(/'/g, "''");
}

function getMarkdownTranscriptionPrompt(imageCount: number): string {
	const pageInstruction = imageCount > 1
		? "These images are ordered pages from the same handwritten note. Merge them into one Markdown note in the same order."
		: "Convert this handwritten note into clean Markdown.";

	return [
		pageInstruction,
		"",
		"Requirements:",
		"- Preserve headings, bullets, numbered lists, indentation, separators, and emphasis when they are visually clear.",
		"- Prefer structured Markdown over plain paragraphs.",
		"- Keep the page order intact.",
		"- If text is unclear, mark it as [illegible].",
		"- If there is a diagram or non-text sketch, insert a short placeholder like [diagram: triangle with arrows and labels].",
		"- Return only the Markdown transcription with no extra commentary.",
	].join("\n");
}

async function transcribeImagesWithOpenAI(files: File[], apiKey: string): Promise<string> {
	if (!apiKey.trim()) {
		throw new Error("Missing OpenAI API key.");
	}

	const content = [
		{
			type: "input_text",
			text: getMarkdownTranscriptionPrompt(files.length),
		},
		...await Promise.all(files.map(async (file) => ({
			type: "input_image" as const,
			image_url: `data:${getImageMediaType(file)};base64,${arrayBufferToBase64(await file.arrayBuffer())}`,
			detail: "high" as const,
		}))),
	];

	const response = await requestUrl({
		url: "https://api.openai.com/v1/responses",
		method: "POST",
		contentType: "application/json",
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: OPENAI_MODEL,
			input: [
				{
					role: "user",
					content,
				},
			],
			max_output_tokens: MAX_OUTPUT_TOKENS,
		}),
		throw: false,
	});

	if (response.status >= 400) {
		throw new Error(getProviderErrorMessage("OpenAI", response.json, response.text));
	}

	const markdown = extractOpenAIOutputText(response.json);
	if (!markdown) {
		throw new Error("OpenAI returned no text output.");
	}

	return markdown;
}

async function transcribeWithOpenAI(
	file: File,
	kind: SupportedUploadKind,
	base64: string,
	apiKey: string,
): Promise<string> {
	if (!apiKey.trim()) {
		throw new Error("Missing OpenAI API key.");
	}

	const content = kind === "pdf"
		? [
			{
				type: "input_file",
				file_id: await uploadPdfToOpenAI(file, apiKey),
			},
			{
				type: "input_text",
				text: getMarkdownTranscriptionPrompt(1),
			},
		]
		: [
			{
				type: "input_text",
				text: getMarkdownTranscriptionPrompt(1),
			},
			{
				type: "input_image",
				image_url: `data:${getImageMediaType(file)};base64,${base64}`,
				detail: "high",
			},
		];

	const response = await requestUrl({
		url: "https://api.openai.com/v1/responses",
		method: "POST",
		contentType: "application/json",
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: OPENAI_MODEL,
			input: [
				{
					role: "user",
					content,
				},
			],
			max_output_tokens: MAX_OUTPUT_TOKENS,
		}),
		throw: false,
	});

	if (response.status >= 400) {
		throw new Error(getProviderErrorMessage("OpenAI", response.json, response.text));
	}

	const markdown = extractOpenAIOutputText(response.json);
	if (!markdown) {
		throw new Error("OpenAI returned no text output.");
	}

	return markdown;
}

async function uploadPdfToOpenAI(file: File, apiKey: string): Promise<string> {
	const boundary = `----hto-${crypto.randomUUID()}`;
	const encoder = new TextEncoder();
	const pdfBytes = new Uint8Array(await file.arrayBuffer());
	const sanitizedFilename = file.name.replace(/"/g, "");

	const multipartBody = concatUint8Arrays([
		encoder.encode(
			`--${boundary}\r\n`
			+ `Content-Disposition: form-data; name="purpose"\r\n\r\n`
			+ `user_data\r\n`
			+ `--${boundary}\r\n`
			+ `Content-Disposition: form-data; name="file"; filename="${sanitizedFilename}"\r\n`
			+ `Content-Type: application/pdf\r\n\r\n`,
		),
		pdfBytes,
		encoder.encode(`\r\n--${boundary}--\r\n`),
	]);
	const requestBody = new Uint8Array(multipartBody).buffer;

	const response = await requestUrl({
		url: "https://api.openai.com/v1/files",
		method: "POST",
		contentType: `multipart/form-data; boundary=${boundary}`,
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
		body: requestBody,
		throw: false,
	});

	if (response.status >= 400) {
		throw new Error(getProviderErrorMessage("OpenAI file upload", response.json, response.text));
	}

	if (!isRecord(response.json) || typeof response.json.id !== "string" || !response.json.id) {
		throw new Error("OpenAI file upload returned no file ID.");
	}

	return response.json.id;
}

async function transcribeImagesWithAnthropic(files: File[], apiKey: string): Promise<string> {
	if (!apiKey.trim()) {
		throw new Error("Missing Anthropic API key.");
	}

	const content = [
		{
			type: "text",
			text: getMarkdownTranscriptionPrompt(files.length),
		},
		...await Promise.all(files.map(async (file) => ({
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: getImageMediaType(file),
				data: arrayBufferToBase64(await file.arrayBuffer()),
			},
		}))),
	];

	const response = await requestUrl({
		url: "https://api.anthropic.com/v1/messages",
		method: "POST",
		contentType: "application/json",
		headers: {
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({
			model: ANTHROPIC_MODEL,
			max_tokens: MAX_OUTPUT_TOKENS,
			messages: [
				{
					role: "user",
					content,
				},
			],
		}),
		throw: false,
	});

	if (response.status >= 400) {
		throw new Error(getProviderErrorMessage("Anthropic", response.json, response.text));
	}

	const markdown = extractAnthropicOutputText(response.json);
	if (!markdown) {
		throw new Error("Anthropic returned no text output.");
	}

	return markdown;
}

async function transcribeWithAnthropic(
	file: File,
	kind: SupportedUploadKind,
	base64: string,
	apiKey: string,
): Promise<string> {
	if (!apiKey.trim()) {
		throw new Error("Missing Anthropic API key.");
	}

	const content = kind === "pdf"
		? [
			{
				type: "document",
				source: {
					type: "base64",
					media_type: "application/pdf",
					data: base64,
				},
			},
			{
				type: "text",
				text: getMarkdownTranscriptionPrompt(1),
			},
		]
		: [
			{
				type: "image",
				source: {
					type: "base64",
					media_type: getImageMediaType(file),
					data: base64,
				},
			},
			{
				type: "text",
				text: getMarkdownTranscriptionPrompt(1),
			},
		];

	const response = await requestUrl({
		url: "https://api.anthropic.com/v1/messages",
		method: "POST",
		contentType: "application/json",
		headers: {
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({
			model: ANTHROPIC_MODEL,
			max_tokens: MAX_OUTPUT_TOKENS,
			messages: [
				{
					role: "user",
					content,
				},
			],
		}),
		throw: false,
	});

	if (response.status >= 400) {
		throw new Error(getProviderErrorMessage("Anthropic", response.json, response.text));
	}

	const markdown = extractAnthropicOutputText(response.json);
	if (!markdown) {
		throw new Error("Anthropic returned no text output.");
	}

	return markdown;
}

function extractOpenAIOutputText(responseJson: unknown): string {
	if (!isRecord(responseJson)) {
		return "";
	}

	const output = responseJson.output;
	if (!Array.isArray(output)) {
		return "";
	}

	const parts: string[] = [];
	for (const item of output) {
		if (!isRecord(item) || item.type !== "message") {
			continue;
		}

		const content = item.content;
		if (!Array.isArray(content)) {
			continue;
		}

		for (const part of content) {
			if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") {
				parts.push(part.text);
			}
		}
	}

	return parts.join("\n").trim();
}

function extractAnthropicOutputText(responseJson: unknown): string {
	if (!isRecord(responseJson)) {
		return "";
	}

	const content = responseJson.content;
	if (!Array.isArray(content)) {
		return "";
	}

	const parts: string[] = [];
	for (const part of content) {
		if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
			parts.push(part.text);
		}
	}

	return parts.join("\n").trim();
}

function getProviderErrorMessage(provider: string, responseJson: unknown, responseText: string): string {
	const structuredMessage = extractErrorMessage(responseJson);
	if (structuredMessage) {
		return `${provider} request failed: ${structuredMessage}`;
	}

	const trimmedText = responseText.trim();
	if (trimmedText) {
		return `${provider} request failed: ${trimmedText}`;
	}

	return `${provider} request failed.`;
}

function extractErrorMessage(value: unknown): string | null {
	if (!isRecord(value)) {
		return null;
	}

	const error = value.error;
	if (typeof error === "string") {
		return error;
	}

	if (isRecord(error) && typeof error.message === "string") {
		return error.message;
	}

	const message = value.message;
	if (typeof message === "string") {
		return message;
	}

	return null;
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
	const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const result = new Uint8Array(totalLength);
	let offset = 0;

	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}

	return result;
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null;
}
