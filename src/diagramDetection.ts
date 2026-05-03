/**
 * diagramDetection.ts
 *
 * Calls Claude with an image and forces it (via tool-use) to return a structured
 * list of diagram bounding boxes in normalized 0-1000 coordinates.
 *
 * This is intentionally a separate code path from the markdown transcription so
 * we can iterate on bbox accuracy without disturbing the working pipeline.
 */

import { arrayBufferToBase64, requestUrl } from "obsidian";

const ANTHROPIC_DETECTION_MODEL = "claude-opus-4-7";
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
	/** Scale used for the normalized coordinates (always 1000 for now). */
	normalizationScale: number;
	/** Raw response, kept for debugging. */
	raw: unknown;
}

/**
 * Detect diagrams in an image. Returns bbox coordinates normalized to 0-1000.
 * The caller is responsible for resizing the image first; pass the resized File.
 */
export async function detectDiagrams(
	file: File,
	apiKey: string,
): Promise<DiagramDetectionResult> {
	if (!apiKey.trim()) {
		throw new Error("Missing Anthropic API key.");
	}

	const mediaType = file.type || "image/png";
	const base64 = arrayBufferToBase64(await file.arrayBuffer());

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
			tools: [REPORT_DIAGRAMS_TOOL],
			tool_choice: { type: "tool", name: "report_diagrams" },
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image",
							source: {
								type: "base64",
								media_type: mediaType,
								data: base64,
							},
						},
						{
							type: "text",
							text: getDetectionPrompt(),
						},
					],
				},
			],
		}),
		throw: false,
	});

	if (response.status >= 400) {
		throw new Error(formatApiError(response.json, response.text));
	}

	const toolInput = extractToolInput(response.json);
	if (!toolInput) {
		throw new Error("Claude did not return a tool_use block.");
	}

	const diagrams = validateDiagramList(toolInput.diagrams);

	return {
		diagrams,
		normalizationScale: NORMALIZATION_SCALE,
		raw: response.json,
	};
}

const REPORT_DIAGRAMS_TOOL = {
	name: "report_diagrams",
	description:
		"Reports the bounding boxes of every visual diagram, sketch, chart, or non-text drawing found in the image. Do NOT report regions that contain only handwritten text.",
	input_schema: {
		type: "object",
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
	},
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

function extractToolInput(responseJson: unknown): { diagrams: unknown } | null {
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

function formatApiError(json: unknown, text: string): string {
	if (isRecord(json) && isRecord(json.error) && typeof json.error.message === "string") {
		return `Anthropic detection request failed: ${json.error.message}`;
	}
	return `Anthropic detection request failed: ${text.trim() || "unknown error"}`;
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null;
}