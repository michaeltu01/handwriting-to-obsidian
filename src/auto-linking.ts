/**
 * auto-linking.ts
 *
 * Discovers semantic references between transcribed markdown and existing vault
 * notes using LLM tool use, and applies confirmed links as wikilinks.
 *
 * The approach sends the transcription plus compact summaries of candidate vault
 * notes to the configured LLM (OpenAI or Anthropic) and asks it to identify
 * text spans that reference existing notes. This avoids the need for a separate
 * embedding model or API and works identically across both providers.
 */

import { requestUrl } from "obsidian";
import type { HandwritingProvider } from "./settings.js";

const OPENAI_MODEL = "gpt-4o-mini";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_OUTPUT_TOKENS = 4096;

/**
 * Maximum number of candidate notes to send to the LLM. Keeps the prompt
 * within context-window limits (~100 tokens per summary × 800 = ~80K tokens).
 */
const MAX_CANDIDATE_NOTES = 800;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProposedLink {
	/** Exact text span in the transcription markdown. */
	spanText: string;
	/** Start index of the span in the markdown string. */
	spanStart: number;
	/** Filename (without extension) of the target vault note. */
	targetNote: string;
	/** Full vault path of the target note (for display / disambiguation). */
	targetPath: string;
	/** Short excerpt around the span for display in the confirmation modal. */
	contextExcerpt: string;
}

interface CandidateNote {
	basename: string;
	path: string;
	summary: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover semantic links between the transcription and existing vault notes
 * by calling the configured LLM with tool use.
 */
export async function discoverLinks(args: {
	markdown: string;
	candidateNotes: CandidateNote[];
	apiKey: string;
	provider: HandwritingProvider;
}): Promise<ProposedLink[]> {
	const { markdown, apiKey, provider } = args;
	let { candidateNotes } = args;

	if (candidateNotes.length === 0 || !markdown.trim()) {
		return [];
	}

	if (candidateNotes.length > MAX_CANDIDATE_NOTES) {
		console.warn(
			`Auto-linking: ${candidateNotes.length} candidate notes exceeds limit of ${MAX_CANDIDATE_NOTES}. ` +
			`Truncating to notes with shortest vault paths.`,
		);
		candidateNotes = candidateNotes
			.slice()
			.sort((a, b) => a.path.length - b.path.length)
			.slice(0, MAX_CANDIDATE_NOTES);
	}

	const rawLinks = provider === "anthropic"
		? await discoverWithAnthropic(markdown, candidateNotes, apiKey)
		: await discoverWithOpenAI(markdown, candidateNotes, apiKey);

	return resolveLinks(markdown, rawLinks, candidateNotes);
}

/**
 * Apply confirmed links to the markdown, returning the modified text.
 * Links are applied back-to-front so earlier replacements don't shift later
 * indices. Overlapping spans are resolved by keeping the longer one.
 */
export function applyLinks(markdown: string, confirmedLinks: ProposedLink[]): string {
	if (confirmedLinks.length === 0) return markdown;

	// Sort by spanStart descending so we process from end to start.
	const sorted = confirmedLinks.slice().sort((a, b) => b.spanStart - a.spanStart);

	// Track applied ranges to detect overlaps.
	const appliedRanges: { start: number; end: number }[] = [];
	let result = markdown;

	for (const link of sorted) {
		const spanEnd = link.spanStart + link.spanText.length;

		// Check for overlap with already-applied spans. If overlapping, the
		// previously applied (longer or earlier-processed) span wins.
		const overlaps = appliedRanges.some(
			(r) => link.spanStart < r.end && spanEnd > r.start,
		);
		if (overlaps) continue;

		const replacement = link.spanText.toLowerCase() === link.targetNote.toLowerCase()
			? `[[${link.targetNote}]]`
			: `[[${link.targetNote}|${link.spanText}]]`;

		result = result.slice(0, link.spanStart) + replacement + result.slice(spanEnd);
		appliedRanges.push({ start: link.spanStart, end: spanEnd });
	}

	return result;
}

/**
 * Build a compact summary of a note for inclusion in the LLM prompt.
 * Strips YAML frontmatter, extracts a title, and takes the first ~150 chars
 * of body text.
 */
export function buildNoteSummary(basename: string, content: string): string {
	const body = stripFrontmatter(content).trim();
	if (!body) return basename;

	// Try to extract a title from the first H1.
	const h1Match = body.match(/^#\s+(.+)$/m);
	const title = h1Match?.[1]?.trim() ?? "";

	// Take the first ~150 chars of body text after the title line.
	const bodyAfterTitle = h1Match
		? body.slice(body.indexOf("\n", h1Match.index ?? 0) + 1).trim()
		: body;
	const excerpt = bodyAfterTitle.replace(/\s+/g, " ").slice(0, 150).trim();

	if (title && title.toLowerCase() !== basename.toLowerCase()) {
		return excerpt ? `${basename} (${title}) — ${excerpt}` : `${basename} (${title})`;
	}

	return excerpt ? `${basename} — ${excerpt}` : basename;
}

// ---------------------------------------------------------------------------
// LLM calls
// ---------------------------------------------------------------------------

interface RawLinkResult {
	span_text: string;
	target_note_index: number;
}

async function discoverWithAnthropic(
	markdown: string,
	candidates: CandidateNote[],
	apiKey: string,
): Promise<RawLinkResult[]> {
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
			max_tokens: MAX_OUTPUT_TOKENS,
			tools: [ANTHROPIC_REPORT_LINKS_TOOL],
			tool_choice: { type: "tool", name: "report_links" },
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: buildLinkDiscoveryPrompt(markdown, candidates) },
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
		throw new Error("Anthropic did not return a tool_use block for report_links.");
	}

	return validateRawLinks(toolInput.links, candidates.length);
}

async function discoverWithOpenAI(
	markdown: string,
	candidates: CandidateNote[],
	apiKey: string,
): Promise<RawLinkResult[]> {
	const response = await requestUrl({
		url: "https://api.openai.com/v1/responses",
		method: "POST",
		contentType: "application/json",
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: OPENAI_MODEL,
			max_output_tokens: MAX_OUTPUT_TOKENS,
			tools: [OPENAI_REPORT_LINKS_TOOL],
			tool_choice: { type: "function", name: "report_links" },
			input: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: buildLinkDiscoveryPrompt(markdown, candidates) },
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
		throw new Error("OpenAI did not return a function_call output for report_links.");
	}

	return validateRawLinks(toolInput.links, candidates.length);
}

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const REPORT_LINKS_SCHEMA = {
	type: "object" as const,
	properties: {
		links: {
			type: "array",
			description:
				"List of semantic links found. Empty array if no references are found.",
			items: {
				type: "object",
				properties: {
					span_text: {
						type: "string",
						description:
							"The exact text from the transcription that references the note. " +
							"Must be a verbatim substring of the transcription.",
					},
					target_note_index: {
						type: "integer",
						description:
							"The 0-based index of the target note in the candidate list.",
					},
				},
				required: ["span_text", "target_note_index"],
			},
		},
	},
	required: ["links"],
};

const ANTHROPIC_REPORT_LINKS_TOOL = {
	name: "report_links",
	description:
		"Identify text spans in the transcription that semantically reference an existing vault note.",
	input_schema: REPORT_LINKS_SCHEMA,
};

const OPENAI_REPORT_LINKS_TOOL = {
	type: "function",
	name: "report_links",
	description:
		"Identify text spans in the transcription that semantically reference an existing vault note.",
	parameters: REPORT_LINKS_SCHEMA,
};

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildLinkDiscoveryPrompt(markdown: string, candidates: CandidateNote[]): string {
	const candidateList = candidates
		.map((c, i) => `[${i}] ${c.summary}`)
		.join("\n");

	return [
		"You are analyzing a transcribed handwritten note to find semantic references to existing notes in the user's vault.",
		"",
		"## Transcription",
		"",
		markdown,
		"",
		"## Existing vault notes",
		"",
		candidateList,
		"",
		"## Instructions",
		"",
		"Identify text spans in the transcription that semantically reference one of the existing vault notes listed above.",
		"A reference means the transcription text discusses, mentions, or is clearly about the same topic as the vault note.",
		"",
		"Rules:",
		"- Only propose a link when there is a genuine semantic connection — not just because a common word appears in both.",
		"- The span_text must be a verbatim, contiguous substring of the transcription. Do not paraphrase or modify it.",
		"- Prefer longer, more specific spans over single common words.",
		"- Do not link inside markdown syntax: heading markers (#), link brackets ([[...]]), image embeds (![[...]]), code blocks (```), YAML frontmatter (---), or <DIAGRAM_n> placeholders.",
		"- A single span may only link to one target. Pick the strongest match if multiple notes are plausible.",
		"- Return an empty links array if no genuine references are found. An empty array is a valid and frequently correct answer.",
		"",
		"Call the report_links tool with your findings.",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function extractAnthropicToolInput(responseJson: unknown): { links: unknown } | null {
	if (!isRecord(responseJson)) return null;
	const content = responseJson.content;
	if (!Array.isArray(content)) return null;

	for (const block of content) {
		if (
			isRecord(block)
			&& block.type === "tool_use"
			&& block.name === "report_links"
			&& isRecord(block.input)
		) {
			return block.input as { links: unknown };
		}
	}
	return null;
}

function extractOpenAIToolInput(responseJson: unknown): { links: unknown } | null {
	if (!isRecord(responseJson)) return null;
	const output = responseJson.output;
	if (!Array.isArray(output)) return null;

	for (const item of output) {
		if (!isRecord(item)) continue;
		if (item.type !== "function_call") continue;
		if (item.name !== "report_links") continue;
		if (typeof item.arguments !== "string") continue;
		try {
			const parsed = JSON.parse(item.arguments);
			if (isRecord(parsed)) {
				return parsed as { links: unknown };
			}
		} catch {
			return null;
		}
	}
	return null;
}

function validateRawLinks(value: unknown, candidateCount: number): RawLinkResult[] {
	if (!Array.isArray(value)) return [];

	const result: RawLinkResult[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		if (typeof item.span_text !== "string" || !item.span_text.trim()) continue;
		const index = typeof item.target_note_index === "number"
			? Math.round(item.target_note_index)
			: null;
		if (index === null || index < 0 || index >= candidateCount) continue;

		result.push({
			span_text: item.span_text,
			target_note_index: index,
		});
	}
	return result;
}

// ---------------------------------------------------------------------------
// Link resolution
// ---------------------------------------------------------------------------

/**
 * Resolve raw LLM results into ProposedLink objects by locating each span in
 * the markdown and building context excerpts.
 */
function resolveLinks(
	markdown: string,
	rawLinks: RawLinkResult[],
	candidates: CandidateNote[],
): ProposedLink[] {
	const result: ProposedLink[] = [];
	const markdownLower = markdown.toLowerCase();

	for (const raw of rawLinks) {
		const candidate = candidates[raw.target_note_index];

		// Try exact match first, then case-insensitive.
		let spanStart = markdown.indexOf(raw.span_text);
		if (spanStart === -1) {
			spanStart = markdownLower.indexOf(raw.span_text.toLowerCase());
		}
		if (spanStart === -1) continue;

		// Use the actual text from the markdown (preserves original casing).
		const spanText = markdown.slice(spanStart, spanStart + raw.span_text.length);

		// Skip spans that fall inside markdown syntax we shouldn't link.
		if (isInsideMarkdownSyntax(markdown, spanStart, spanText.length)) continue;

		result.push({
			spanText,
			spanStart,
			targetNote: candidate.basename,
			targetPath: candidate.path,
			contextExcerpt: buildContextExcerpt(markdown, spanStart, spanText.length),
		});
	}

	return result;
}

/**
 * Check if a position in the markdown is inside syntax that shouldn't be
 * linked: YAML frontmatter, code blocks, existing wikilinks, image embeds,
 * or diagram placeholders.
 */
function isInsideMarkdownSyntax(
	markdown: string,
	start: number,
	length: number,
): boolean {
	const end = start + length;
	const before = markdown.slice(0, start);
	const span = markdown.slice(start, end);

	// Inside YAML frontmatter (between opening and closing ---).
	if (markdown.startsWith("---\n") || markdown.startsWith("---\r\n")) {
		const closingDashes = markdown.indexOf("\n---", 4);
		if (closingDashes !== -1 && start < closingDashes + 4) {
			return true;
		}
	}

	// Inside a fenced code block.
	const codeBlockRegex = /```[\s\S]*?```/g;
	let match;
	while ((match = codeBlockRegex.exec(markdown)) !== null) {
		if (start >= match.index && end <= match.index + match[0].length) {
			return true;
		}
	}

	// Inside an existing wikilink [[ ... ]].
	const lastOpenBracket = before.lastIndexOf("[[");
	if (lastOpenBracket !== -1) {
		const closingBracket = markdown.indexOf("]]", lastOpenBracket);
		if (closingBracket !== -1 && closingBracket >= end) {
			return true;
		}
	}

	// Inside an image embed ![[...]] — the [[ check above covers this too,
	// but be explicit.
	if (lastOpenBracket !== -1 && lastOpenBracket > 0 && markdown[lastOpenBracket - 1] === "!") {
		return true;
	}

	// Diagram placeholder <DIAGRAM_n>.
	if (/^<DIAGRAM_\d+>$/.test(span.trim())) {
		return true;
	}

	return false;
}

/**
 * Build a short excerpt around the span for display in the confirmation modal.
 * Shows ~40 chars on each side of the span.
 */
function buildContextExcerpt(markdown: string, start: number, length: number): string {
	const contextRadius = 40;
	const excerptStart = Math.max(0, start - contextRadius);
	const excerptEnd = Math.min(markdown.length, start + length + contextRadius);

	let excerpt = markdown.slice(excerptStart, excerptEnd).replace(/\s+/g, " ");
	if (excerptStart > 0) excerpt = "…" + excerpt;
	if (excerptEnd < markdown.length) excerpt = excerpt + "…";

	return excerpt;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripFrontmatter(content: string): string {
	if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
		return content;
	}
	const endIndex = content.indexOf("\n---", 4);
	if (endIndex === -1) return content;
	return content.slice(endIndex + 4).trim();
}

function formatApiError(provider: string, json: unknown, text: string): string {
	if (isRecord(json) && isRecord(json.error) && typeof json.error.message === "string") {
		return `${provider} auto-linking request failed: ${json.error.message}`;
	}
	return `${provider} auto-linking request failed: ${text.trim() || "unknown error"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
