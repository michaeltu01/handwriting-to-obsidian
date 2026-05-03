/**
 * mermaidGeneration.ts
 *
 * Take a cropped hand-drawn diagram image plus its detection metadata, ask the
 * configured LLM to convert it to Mermaid code.
 *
 * The output is plain Mermaid syntax (no leading/trailing code fences). The
 * caller wraps it in a ```mermaid block when inserting into markdown.
 *
 * Supports both Anthropic and OpenAI providers, mirroring diagramDetection.
 */

import { arrayBufferToBase64, requestUrl } from "obsidian";
import type { HandwritingProvider } from "./settings";

const ANTHROPIC_MODEL = "claude-opus-4-7";
const OPENAI_MODEL = "gpt-4o";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 2048;

export interface MermaidGenerationInput {
	croppedImage: File;
	/** Free-form description of the diagram from the detection step. */
	description: string;
	/** Suggested Mermaid diagram class. Honored only when it makes sense. */
	suggestedType: string;
}

export interface MermaidGenerationConfig {
	apiKey: string;
	provider: HandwritingProvider;
}

export interface MermaidGenerationResult {
	mermaidCode: string;
	raw: unknown;
}

/**
 * Convert a hand-drawn diagram image into Mermaid code via the configured LLM.
 */
export async function generateMermaidFromImage(
	input: MermaidGenerationInput,
	config: MermaidGenerationConfig,
): Promise<MermaidGenerationResult> {
	if (!config.apiKey.trim()) {
		throw new Error("Missing API key.");
	}

	const mediaType = input.croppedImage.type || "image/png";
	const base64 = arrayBufferToBase64(await input.croppedImage.arrayBuffer());

	if (config.provider === "anthropic") {
		return await generateWithAnthropic(base64, mediaType, input, config.apiKey);
	}
	return await generateWithOpenAI(base64, mediaType, input, config.apiKey);
}

async function generateWithAnthropic(
	base64: string,
	mediaType: string,
	input: MermaidGenerationInput,
	apiKey: string,
): Promise<MermaidGenerationResult> {
	const response = await requestUrl({
		url: "https://api.anthropic.com/v1/messages",
		method: "POST",
		contentType: "application/json",
		headers: {
			"x-api-key": apiKey,
			"anthropic-version": ANTHROPIC_VERSION,
		},
		body: JSON.stringify({
			model: ANTHROPIC_MODEL,
			max_tokens: MAX_TOKENS,
			tools: [ANTHROPIC_GENERATE_TOOL],
			tool_choice: { type: "tool", name: "generate_mermaid" },
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image",
							source: { type: "base64", media_type: mediaType, data: base64 },
						},
						{ type: "text", text: getGenerationPrompt(input) },
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

	const code = stripFences(typeof toolInput.mermaid_code === "string" ? toolInput.mermaid_code : "");
	if (!code) throw new Error("Claude returned no Mermaid code.");

	return { mermaidCode: code, raw: response.json };
}

async function generateWithOpenAI(
	base64: string,
	mediaType: string,
	input: MermaidGenerationInput,
	apiKey: string,
): Promise<MermaidGenerationResult> {
	const response = await requestUrl({
		url: "https://api.openai.com/v1/responses",
		method: "POST",
		contentType: "application/json",
		headers: { Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({
			model: OPENAI_MODEL,
			max_output_tokens: MAX_TOKENS,
			tools: [OPENAI_GENERATE_TOOL],
			tool_choice: { type: "function", name: "generate_mermaid" },
			input: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: getGenerationPrompt(input) },
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

	const code = stripFences(typeof toolInput.mermaid_code === "string" ? toolInput.mermaid_code : "");
	if (!code) throw new Error("OpenAI returned no Mermaid code.");

	return { mermaidCode: code, raw: response.json };
}

const GENERATE_MERMAID_SCHEMA = {
	type: "object" as const,
	properties: {
		mermaid_code: {
			type: "string",
			description:
				"Valid Mermaid syntax that recreates the structure of the hand-drawn diagram. Do NOT wrap in ```mermaid fences. Just the raw syntax, starting with the diagram type declaration (e.g. 'flowchart TD', 'stateDiagram-v2', 'sequenceDiagram', 'mindmap').",
		},
	},
	required: ["mermaid_code"],
};

const ANTHROPIC_GENERATE_TOOL = {
	name: "generate_mermaid",
	description: "Returns Mermaid code that recreates the structure of a hand-drawn diagram.",
	input_schema: GENERATE_MERMAID_SCHEMA,
};

const OPENAI_GENERATE_TOOL = {
	type: "function",
	name: "generate_mermaid",
	description: "Returns Mermaid code that recreates the structure of a hand-drawn diagram.",
	parameters: GENERATE_MERMAID_SCHEMA,
};

function getGenerationPrompt(input: MermaidGenerationInput): string {
	return [
		"You are looking at a cropped photo of a hand-drawn diagram from someone's notebook.",
		"Convert it to Mermaid code that preserves the structure as faithfully as possible.",
		"",
		`Detected type: ${input.suggestedType}`,
		`Description from prior pass: ${input.description}`,
		"",
		"Guidelines:",
		"- Choose the most appropriate Mermaid diagram class. Common choices: 'flowchart TD' (top-down) or 'flowchart LR' (left-right) for flowcharts and architecture diagrams; 'stateDiagram-v2' for state machines; 'sequenceDiagram' for time-ordered interactions; 'mindmap' for hierarchical bubbles; 'classDiagram' for boxes-with-fields. If unsure, default to 'flowchart TD'.",
		"- Preserve every node label exactly as written. If text is unreadable, write [illegible].",
		"- Preserve every edge. Use arrows that match the diagram (--> for directed, --- for undirected, -.-> for dashed).",
		"- If there is a label on an edge (like 'residual' on a connection), put it on the edge: A --|residual|--> B.",
		"- Do NOT invent nodes or edges that are not in the drawing.",
		"- Do NOT add styling, colors, or comments. Just structure.",
		"- Return only the raw Mermaid syntax. Do NOT wrap in ```mermaid fences. Do NOT add prose.",
		"",
		"Call the generate_mermaid tool with the resulting code.",
	].join("\n");
}

function extractAnthropicToolInput(responseJson: unknown): { mermaid_code: unknown } | null {
	if (!isRecord(responseJson)) return null;
	const content = responseJson.content;
	if (!Array.isArray(content)) return null;

	for (const block of content) {
		if (
			isRecord(block)
			&& block.type === "tool_use"
			&& block.name === "generate_mermaid"
			&& isRecord(block.input)
		) {
			return block.input as { mermaid_code: unknown };
		}
	}
	return null;
}

function extractOpenAIToolInput(responseJson: unknown): { mermaid_code: unknown } | null {
	if (!isRecord(responseJson)) return null;
	const output = responseJson.output;
	if (!Array.isArray(output)) return null;

	for (const item of output) {
		if (!isRecord(item)) continue;
		if (item.type !== "function_call") continue;
		if (item.name !== "generate_mermaid") continue;
		if (typeof item.arguments !== "string") continue;
		try {
			const parsed = JSON.parse(item.arguments);
			if (isRecord(parsed)) {
				return parsed as { mermaid_code: unknown };
			}
		} catch {
			return null;
		}
	}
	return null;
}

/**
 * Defensive: strip leading/trailing ```mermaid fences if the model includes them
 * despite the prompt asking it not to.
 */
function stripFences(code: string): string {
	let s = code.trim();
	if (s.startsWith("```")) {
		const firstNewline = s.indexOf("\n");
		s = firstNewline === -1 ? "" : s.slice(firstNewline + 1);
	}
	if (s.endsWith("```")) {
		s = s.slice(0, s.length - 3);
	}
	return s.trim();
}

function formatApiError(provider: string, json: unknown, text: string): string {
	if (isRecord(json) && isRecord(json.error) && typeof json.error.message === "string") {
		return `${provider} mermaid generation failed: ${json.error.message}`;
	}
	return `${provider} mermaid generation failed: ${text.trim() || "unknown error"}`;
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null;
}