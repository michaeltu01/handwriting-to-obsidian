/**
 * diagramPlaceholder.ts
 *
 * Helpers for working with diagram placeholders inside markdown.
 *
 * Two related concepts here:
 *
 * 1. TRANSCRIPTION PLACEHOLDER (`<DIAGRAM_n>`):
 *    The transcription prompt instructs the LLM to emit `<DIAGRAM_1>`,
 *    `<DIAGRAM_2>`, etc. wherever a diagram appears in the page. After
 *    transcription, we replace each `<DIAGRAM_n>` with the rendered diagram
 *    block (image embed plus regen-prompt callout).
 *
 * 2. RENDERED DIAGRAM BLOCK:
 *    The block we put into the final markdown. It contains:
 *      - A start marker `%%handwriting-to-obsidian:diagram id="n"%%`
 *      - An Obsidian image embed `![[filename.png]]`
 *      - A Mermaid code block (only after the user runs the regenerate command;
 *        before regeneration this slot holds an [!info] callout instead)
 *      - An end marker `%%handwriting-to-obsidian:diagram-end%%`
 *
 *    The `%% %%` syntax is Obsidian's native comment format: invisible in both
 *    reading and live-preview modes, visible in source mode only. The markers
 *    let the "Regenerate diagrams in this note" command find blocks reliably
 *    without fragile regex matching against user-edited text.
 */

const PLACEHOLDER_PATTERN = /<DIAGRAM_(\d+)>/g;

const REGEN_CALLOUT = [
	"> [!info] This diagram can be regenerated as a clean digital version.",
	"> Run the command \"Regenerate diagrams in this note\" to convert.",
].join("\n");

/**
 * Builds the markdown block we insert in place of each `<DIAGRAM_n>` placeholder
 * during import. Before regeneration, the block holds an info callout. The
 * regenerate command later replaces that callout with a Mermaid code block.
 */
export function buildDiagramBlock(options: {
	id: number;
	imageVaultPath: string;
}): string {
	const { id, imageVaultPath } = options;
	return [
		startMarker(id),
		`![[${imageVaultPath}]]`,
		"",
		REGEN_CALLOUT,
		endMarker(),
	].join("\n");
}

/**
 * Replaces every `<DIAGRAM_n>` in the markdown with the corresponding rendered
 * block. `blocksById` must contain a block for every id referenced in the
 * markdown; missing ids are left as-is so the user can see which ones failed.
 */
export function substitutePlaceholders(
	markdown: string,
	blocksById: Map<number, string>,
): string {
	return markdown.replace(PLACEHOLDER_PATTERN, (match, idStr) => {
		const id = Number(idStr);
		const block = blocksById.get(id);
		return block ?? match;
	});
}

/**
 * Lists the ids of every `<DIAGRAM_n>` placeholder in the markdown, in order
 * of appearance. Used to log mismatches between transcription and detection.
 */
export function listPlaceholderIds(markdown: string): number[] {
	const ids: number[] = [];
	for (const match of markdown.matchAll(PLACEHOLDER_PATTERN)) {
		ids.push(Number(match[1]));
	}
	return ids;
}

/**
 * A regenerable diagram block found in an existing note. The regenerate
 * command iterates over these and rewrites the body of each.
 */
export interface RegenerableBlock {
	id: number;
	/** Index in the source markdown where the block (including markers) starts. */
	startIndex: number;
	/** Index where the block ends (inclusive of the end marker line). */
	endIndex: number;
	/** Full text of the block, markers included. */
	fullText: string;
	/** Text of the image embed line, e.g. `![[note-diagram-1.png]]`. */
	imageLine: string;
}

/**
 * Finds every regenerable diagram block in a markdown document.
 * Order of return matches order in the document.
 */
export function findRegenerableBlocks(markdown: string): RegenerableBlock[] {
	const blocks: RegenerableBlock[] = [];
	const startRegex = /%%handwriting-to-obsidian:diagram id="(\d+)"%%/g;
	const endMarkerLiteral = endMarker();

	for (const startMatch of markdown.matchAll(startRegex)) {
		const startIndex = startMatch.index;
		if (startIndex === undefined) continue;

		const id = Number(startMatch[1]);
		const endIndex = markdown.indexOf(endMarkerLiteral, startIndex);
		if (endIndex === -1) continue;

		const blockEnd = endIndex + endMarkerLiteral.length;
		const fullText = markdown.slice(startIndex, blockEnd);

		const imageLine = extractImageLine(fullText);
		if (!imageLine) continue;

		blocks.push({ id, startIndex, endIndex: blockEnd, fullText, imageLine });
	}

	return blocks;
}

/**
 * Rewrites a regenerable block: keeps the image embed, replaces the callout
 * (or any previously-generated content) with a Mermaid code block.
 */
export function rewriteBlockWithMermaid(
	block: RegenerableBlock,
	mermaidCode: string,
): string {
	return [
		startMarker(block.id),
		block.imageLine,
		"",
		"```mermaid",
		mermaidCode.trim(),
		"```",
		endMarker(),
	].join("\n");
}

function startMarker(id: number): string {
	return `%%handwriting-to-obsidian:diagram id="${id}"%%`;
}

function endMarker(): string {
	return "%%handwriting-to-obsidian:diagram-end%%";
}

function extractImageLine(blockText: string): string | null {
	for (const line of blockText.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("![[") && trimmed.endsWith("]]")) {
			return trimmed;
		}
	}
	return null;
}