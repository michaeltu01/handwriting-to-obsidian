/**
 * gptImageGeneration.ts
 *
 * Generates a clean, machine-rendered PNG of a hand-drawn diagram using
 * OpenAI's gpt-image-1 model.
 *
 * Two-call pipeline:
 *   1. A vision model (Claude or GPT-4o, depending on which provider the user
 *      configured) looks at the cropped hand-drawn image and writes a detailed
 *      English description of the diagram's structure, labels, and arrows.
 *   2. That description plus a fixed style modifier is sent to gpt-image-1's
 *      generations endpoint. The endpoint returns a base64-encoded PNG, which
 *      we hand back to the caller as a Uint8Array.
 *
 * Why two calls? gpt-image-1's generation endpoint takes a text prompt only;
 * it cannot ingest a reference image. We use the vision model that already
 * has the user's API key as the "see-the-drawing" half of the loop.
 *
 * All HTTP calls go through Obsidian's requestUrl rather than fetch, to avoid
 * CORS issues when the plugin runs inside the desktop renderer.
 *
 * Cost note: gpt-image-1 at "high" quality is roughly $0.19 per image. We
 * default to high because the result is meant to replace the user's hand
 * drawing in their note; cheap-looking output would defeat the purpose.
 */

import { arrayBufferToBase64, requestUrl } from "obsidian";
import { extractAnthropicOutputText, extractOpenAIOutputText } from "./transcription";
import type { HandwritingProvider } from "./settings";

export interface GptImageGenerationInput {
	croppedImage: File;
	description: string;
	suggestedType: string;
}

export interface GptImageGenerationConfig {
	/** API key for the vision-description step. Anthropic or OpenAI. */
	visionApiKey: string;
	visionProvider: HandwritingProvider;
	/**
	 * OpenAI API key used for the gpt-image-1 call. Often the same as
	 * visionApiKey when the user is on OpenAI for everything; kept separate so
	 * a future "Anthropic-for-vision + OpenAI-for-image" path is additive.
	 */
	openaiApiKey: string;
}

export interface GptImageGenerationResult {
	pngBytes: Uint8Array;
	usedDescription: string;
}

/**
 * End-to-end: cropped image → vision description → gpt-image-1 PNG.
 */
export async function generateGptImageFromDiagram(
	input: GptImageGenerationInput,
	config: GptImageGenerationConfig,
): Promise<GptImageGenerationResult> {
	const description = await describeDiagram(input, config);
	const pngBytes = await callGptImageGeneration(description, config.openaiApiKey);
	return { pngBytes, usedDescription: description };
}

// =========================================================================
// Step 1: vision description
// =========================================================================

async function describeDiagram(
	input: GptImageGenerationInput,
	config: GptImageGenerationConfig,
): Promise<string> {
	const prompt = getDescriptionPrompt(input.suggestedType, input.description);
	const base64Image = arrayBufferToBase64(await input.croppedImage.arrayBuffer());

	if (config.visionProvider === "anthropic") {
		return await describeWithAnthropic(prompt, base64Image, config.visionApiKey);
	}
	return await describeWithOpenAI(prompt, base64Image, config.visionApiKey);
}

function getDescriptionPrompt(suggestedType: string, priorDescription: string): string {
	return [
		"You are looking at a cropped photo of a hand-drawn diagram from someone's notebook.",
		"Write a precise, structured description so a separate image-generation model can recreate it as a clean digital diagram.",
		"",
		`Detected type: ${suggestedType}`,
		`Prior brief description: ${priorDescription}`,
		"",
		"Your description must include:",
		"- The overall layout (top-down, left-to-right, hub-and-spoke, etc.)",
		"- Every node/box with its exact label text",
		"- Every arrow: source node, target node, direction, and any edge label",
		"- Whether arrows are solid or dashed",
		"- Whether the diagram has a residual/back connection or branches off to side notes",
		"",
		"Append these style requirements verbatim at the end of your description:",
		"- Clean modern digital diagram, white background",
		"- Rectangular boxes with rounded corners and thin black borders",
		"- Black text, sans-serif font, no shadows, no gradients",
		"- Straight arrows with simple arrowheads",
		"",
		"Write the description as one or two paragraphs, no markdown, no bullet points. Be specific so the generated image faithfully matches the original structure.",
	].join("\n");
}

async function describeWithAnthropic(
	prompt: string,
	base64Image: string,
	apiKey: string,
): Promise<string> {
	const response = await requestUrl({
		url: "https://api.anthropic.com/v1/messages",
		method: "POST",
		contentType: "application/json",
		headers: {
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			"anthropic-dangerous-direct-browser-access": "true",
		},
		body: JSON.stringify({
			model: "claude-opus-4-5",
			max_tokens: 1500,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image",
							source: { type: "base64", media_type: "image/png", data: base64Image },
						},
						{ type: "text", text: prompt },
					],
				},
			],
		}),
		throw: false,
	});

	if (response.status >= 400) {
		throw new Error(`Anthropic vision call failed (${response.status}): ${response.text}`);
	}
	const text = extractAnthropicOutputText(response.json);
	if (!text) throw new Error("Anthropic returned an empty diagram description.");
	return text.trim();
}

async function describeWithOpenAI(
	prompt: string,
	base64Image: string,
	apiKey: string,
): Promise<string> {
	const response = await requestUrl({
		url: "https://api.openai.com/v1/responses",
		method: "POST",
		contentType: "application/json",
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: "gpt-4o",
			max_output_tokens: 1500,
			input: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: prompt },
						{
							type: "input_image",
							image_url: `data:image/png;base64,${base64Image}`,
							detail: "high",
						},
					],
				},
			],
		}),
		throw: false,
	});

	if (response.status >= 400) {
		throw new Error(`OpenAI vision call failed (${response.status}): ${response.text}`);
	}
	const text = extractOpenAIOutputText(response.json);
	if (!text) throw new Error("OpenAI returned an empty diagram description.");
	return text.trim();
}

// =========================================================================
// Step 2: gpt-image-1 generation
// =========================================================================

async function callGptImageGeneration(
	prompt: string,
	openaiApiKey: string,
): Promise<Uint8Array> {
	const response = await requestUrl({
		url: "https://api.openai.com/v1/images/generations",
		method: "POST",
		contentType: "application/json",
		headers: {
			Authorization: `Bearer ${openaiApiKey}`,
		},
		body: JSON.stringify({
			model: "gpt-image-1",
			prompt,
			n: 1,
			size: "1024x1024",
			quality: "high",
		}),
		throw: false,
	});

	if (response.status >= 400) {
		throw new Error(
			`gpt-image-1 generation failed (${response.status}): ${response.text}`,
		);
	}

	const json = response.json as { data?: Array<{ b64_json?: string }> };
	const b64 = json?.data?.[0]?.b64_json;
	if (typeof b64 !== "string" || b64.length === 0) {
		throw new Error("gpt-image-1 response did not contain an image.");
	}
	return base64ToBytes(b64);
}

function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}