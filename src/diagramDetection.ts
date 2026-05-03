/**
 * diagramDetection.ts
 *
 * Detect diagram regions in an image and return their normalized bounding boxes.
 * Supports both Anthropic (Claude) and OpenAI (GPT-4o) providers via tool use,
 * so detection can run regardless of which API key the user has configured.
 *
 * The caller is responsible for resizing the image first; pass the resized File.
 */

import { arrayBufferToBase64, requestUrl } from "obsidian";
import type { HandwritingProvider } from "./settings";

const ANTHROPIC_DETECTION_MODEL = "claude-opus-4-7";
const OPENAI_DETECTION_MODEL = "gpt-4o";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 2048;
const NORMALIZATION_SCALE = 1000;

export interface DetectedDiagramBbox {
	id: number;
	bbox: { x_min: number; y_min: number; x_max: number; y_max: number };
	type: string;
	description: string;
}

export interface DiagramDetectionResult {
	diagrams: DetectedDiagramBbox[];
	normalizationScale: number;
	raw: unknown;
}

export interface DiagramDetectionConfig {
	apiKey: string;
	provider: HandwritingProvider;
}

/**
 * Detect diagrams in an image. Returns bbox coordinates normalized to 0-1000.
 * Routes to the appropriate vision API based on the configured provider.
 */
export async function detectDiagrams(
	file: File,
	config: DiagramDetectionConfig,
): Promise<DiagramDetectionResult> {
	if (!config.apiKey.trim()) {
		throw new Error("Missing API key.");
	}

	const mediaType = file.type || "image/png";
	const base64 = arrayBufferToBase64(await file.arrayBuffer());

	if (config.provider === "anthropic") {
		return await detectWithAnthropic(base64, mediaType, config.apiKey);
	}
	return await detectWithOpenAI(base64, mediaType, config.apiKey);
}

async function detectWithAnthropic(
	base64: string,
	mediaType: string,
	apiKey: string,
): Promise<DiagramDetectionResult> {
	const response = await requestUrl({
		url: "https://api.anthropic.com/v1/messages",
		method: "POST",
		contentType: "application/json",
		headers: {
			"x-api-key": apiKey,
			"anthropic-version": ANTHROPIC_VERSION,
		},
		body: JSON.stringify({
			model: ANTHROPIC_DETECTION_MODEL,
			max_tokens: MAX_TOKENS,
			tools: [ANTHROPIC_REPORT_DIAGRAMS_TOOL],
			tool_choice: { type: "tool", name: "report_diagrams" },
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image",
							source: { type: "base64", media_type: mediaType, data: base64 },
						},
						{ type: "text", text: getDetectionPrompt() },
					],
				},
			],
		}),
		throw: false,
	});

	if (response.status >= 400) {
		throw new Error(formatApiError("Anthropic", response.json, response.text));
	}

	const toolInput = extractAnthropicToolInput(response.json);
	if (!toolInput) {
		throw new Error("Claude did not return a tool_use block.");
	}

	return {
		diagrams: validateDiagramList(toolInput.diagrams),
		normalizationScale: NORMALIZATION_SCALE,
		raw: response.json,
	};
}

async function detectWithOpenAI(
	base64: string,
	mediaType: string,
	apiKey: string,
): Promise<DiagramDetectionResult> {
	const response = await requestUrl({
		url: "https://api.openai.com/v1/responses",
		method: "POST",
		contentType: "application/json",
		headers: { Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({
			model: OPENAI_DETECTION_MODEL,
			max_output_tokens: MAX_TOKENS,
			tools: [OPENAI_REPORT_DIAGRAMS_TOOL],
			tool_choice: { type: "function", name: "report_diagrams" },
			input: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: getDetectionPrompt() },
						{
							type: "input_image",
							image_url: `data:${mediaType};base64,${base64}`,
							detail: "high",
						},
					],
				},
			],
		}),
		throw: false,
	});

	if (response.status >= 400) {
		throw new Error(formatApiError("OpenAI", response.json, response.text));
	}

	const toolInput = extractOpenAIToolInput(response.json);
	if (!toolInput) {
		throw new Error("OpenAI did not return a function_call output.");
	}

	return {
		diagrams: validateDiagramList(toolInput.diagrams),
		normalizationScale: NORMALIZATION_SCALE,
		raw: response.json,
	};
}

/**
 * Shared schema for the report_diagrams tool. Anthropic and OpenAI use slightly
 * different envelopes around it; the inner schema is identical.
 */
const REPORT_DIAGRAMS_SCHEMA = {
	type: "object" as const,
	properties: {
		diagrams: {
			type: "array",
			description:
				"List of diagrams found in the image. Empty array if there are no diagrams.",
			items: {
				type: "object",
				properties: {
					id: {
						type: "integer",
						description: "1-indexed id, in reading order (top-to-bottom, left-to-right).",
					},
					bbox: {
						type: "object",
						description:
							"Bounding box in normalized image coordinates. (0,0) is the top-left of the image and (1000,1000) is the bottom-right. All values are integers.",
						properties: {
							x_min: { type: "integer", minimum: 0, maximum: 1000 },
							y_min: { type: "integer", minimum: 0, maximum: 1000 },
							x_max: { type: "integer", minimum: 0, maximum: 1000 },
							y_max: { type: "integer", minimum: 0, maximum: 1000 },
						},
						required: ["x_min", "y_min", "x_max", "y_max"],
					},
					type: {
						type: "string",
						description:
							"Short label for the kind of diagram. Examples: flowchart, state_machine, geometry, plot, sequence_diagram, free_sketch, table, schematic.",
					},
					description: {
						type: "string",
						description:
							"One-sentence description of what the diagram depicts. Mention key nodes, edges, or labels you can read.",
					},
				},
				required: ["id", "bbox", "type", "description"],
			},
		},
	},
	required: ["diagrams"],
};

const ANTHROPIC_REPORT_DIAGRAMS_TOOL = {
	name: "report_diagrams",
	description:
		"Reports the bounding boxes of every visual diagram, sketch, chart, or non-text drawing found in the image. Do NOT report regions that contain only handwritten text.",
	input_schema: REPORT_DIAGRAMS_SCHEMA,
};

const OPENAI_REPORT_DIAGRAMS_TOOL = {
	type: "function",
	name: "report_diagrams",
	description:
		"Reports the bounding boxes of every visual diagram, sketch, chart, or non-text drawing found in the image. Do NOT report regions that contain only handwritten text.",
	parameters: REPORT_DIAGRAMS_SCHEMA,
};

function getDetectionPrompt(): string {
	return [
		"Look at this handwritten note. Find every visual diagram, sketch, chart, or non-text drawing.",
		"",
		"IMPORTANT: Most pages of handwritten notes contain ZERO diagrams. Returning an empty list is the correct answer for the majority of pages. Do not invent diagrams.",
		"",
		"What IS a diagram:",
		"- A drawn shape with internal structure (a box around something, a circle, a triangle, a tree of nodes)",
		"- A geometric figure with construction lines (e.g. a triangle with labeled angles)",
		"- A plot or chart with axes",
		"- A mind map drawn with explicit branches and nodes",
		"- A table with drawn ruling lines",
		"- A schematic or sketch of a physical object",
		"",
		"What is NOT a diagram (DO NOT report these, even if they look structured):",
		"- Plain handwritten text, bullet points, or outline-style notes",
		"- Inline arrows like 'X -> Y' or 'A => B' connecting handwritten words. This is shorthand for 'leads to' or 'becomes'. It is text, not a diagram.",
		"- Indented hierarchical notes (e.g. words written on different indent levels with dashes or arrows). This is outline-style writing, not a tree diagram.",
		"- Equations, even if they include arrows, fractions, or matrices",
		"- A list of definitions, even if each line ends with an arrow pointing to a definition",
		"",
		"Concrete test: would the region still make sense if you replaced every arrow with the word 'becomes' or 'leads to'? If yes, it is text, not a diagram. Only report regions where the spatial layout itself carries information that prose could not.",
		"",
		"Other rules:",
		"- Use generous bounding boxes that include all labels attached to the diagram.",
		"- Do not extend the bounding box into surrounding paragraph text or empty whitespace.",
		"- Coordinates are normalized to the integer range 0 to 1000 inclusive. (0,0) is the top-left corner of the entire image. (1000,1000) is the bottom-right corner. Every coordinate value MUST be between 0 and 1000. Do not return values larger than 1000 or smaller than 0 under any circumstances.",
		"- Order diagrams in reading order: top-to-bottom, then left-to-right within the same row.",
		"",
		"Call the report_diagrams tool. If there are no diagrams on the page, return an empty list. An empty list is a valid and frequently correct answer.",
	].join("\n");
}

function extractAnthropicToolInput(responseJson: unknown): { diagrams: unknown } | null {
	if (!isRecord(responseJson)) return null;
	const content = responseJson.content;
	if (!Array.isArray(content)) return null;

	for (const block of content) {
		if (
			isRecord(block)
			&& block.type === "tool_use"
			&& block.name === "report_diagrams"
			&& isRecord(block.input)
		) {
			return block.input as { diagrams: unknown };
		}
	}
	return null;
}

function extractOpenAIToolInput(responseJson: unknown): { diagrams: unknown } | null {
	if (!isRecord(responseJson)) return null;
	const output = responseJson.output;
	if (!Array.isArray(output)) return null;

	for (const item of output) {
		if (!isRecord(item)) continue;
		if (item.type !== "function_call") continue;
		if (item.name !== "report_diagrams") continue;
		if (typeof item.arguments !== "string") continue;
		try {
			const parsed = JSON.parse(item.arguments);
			if (isRecord(parsed)) {
				return parsed as { diagrams: unknown };
			}
		} catch {
			return null;
		}
	}
	return null;
}

function validateDiagramList(value: unknown): DetectedDiagramBbox[] {
	if (!Array.isArray(value)) {
		throw new Error("Tool input did not contain a diagrams array.");
	}

	const result: DetectedDiagramBbox[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const bbox = item.bbox;
		if (!isRecord(bbox)) continue;

		const xMin = toInt(bbox.x_min);
		const yMin = toInt(bbox.y_min);
		const xMax = toInt(bbox.x_max);
		const yMax = toInt(bbox.y_max);
		if (xMin === null || yMin === null || xMax === null || yMax === null) continue;
		if (xMax <= xMin || yMax <= yMin) continue;

		result.push({
			id: toInt(item.id) ?? result.length + 1,
			bbox: { x_min: xMin, y_min: yMin, x_max: xMax, y_max: yMax },
			type: typeof item.type === "string" ? item.type : "unknown",
			description: typeof item.description === "string" ? item.description : "",
		});
	}
	return result;
}

function toInt(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
	if (typeof value === "string") {
		const n = Number(value);
		return Number.isFinite(n) ? Math.round(n) : null;
	}
	return null;
}

function formatApiError(provider: string, json: unknown, text: string): string {
	if (isRecord(json) && isRecord(json.error) && typeof json.error.message === "string") {
		return `${provider} detection request failed: ${json.error.message}`;
	}
	return `${provider} detection request failed: ${text.trim() || "unknown error"}`;
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null;
}