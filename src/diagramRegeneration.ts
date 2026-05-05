/**
 * diagramRegeneration.ts
 *
 * Strategy pattern entry point for converting a hand-drawn diagram into a
 * regenerated, machine-rendered version.
 *
 * Right now we only support Mermaid. The 'gpt-image' branch is reserved for a
 * future PR that adds image-generation support; today it falls back to Mermaid
 * with a console warning so the plugin still produces output for users who
 * select that mode.
 *
 * Adding a new strategy in the future is intended to be additive: implement
 * generate{NewStrategy}, then add a branch here. Callers do not change.
 */

import type { DetectedDiagramBbox } from "./diagramDetection";
import { generateMermaidFromImage } from "./mermaidGeneration";
import type { DiagramRegenerationMethod, HandwritingProvider } from "./settings";

export interface RegenerationContext {
	croppedImage: File;
	bbox: DetectedDiagramBbox;
	apiKey: string;
	provider: HandwritingProvider;
	method: DiagramRegenerationMethod;
}

export interface RegeneratedDiagram {
	/**
	 * Raw payload without any markdown fences or block markers. The shape
	 * depends on `usedStrategy`:
	 *  - mermaid:   plain Mermaid syntax (caller wraps in ```mermaid block)
	 *  - gpt-image: vault path to the generated image (caller wraps in ![[...]])
	 */
	payload: string;
	/** Which strategy was actually used. Useful for logging and debug UIs. */
	usedStrategy: "mermaid" | "gpt-image";
}

/**
 * Pick a strategy and return a regenerated representation of the diagram.
 */
export async function regenerateDiagram(
	ctx: RegenerationContext,
): Promise<RegeneratedDiagram> {
	const strategy = pickStrategy(ctx);

	if (strategy === "mermaid") {
		return await runMermaid(ctx);
	}

	// Reserved for a future PR. For now log and fall back.
	console.warn(
		"diagramRegeneration: gpt-image strategy is not implemented yet. Falling back to Mermaid.",
	);
	return await runMermaid(ctx);
}

function pickStrategy(ctx: RegenerationContext): "mermaid" | "gpt-image" {
	if (ctx.method === "mermaid") return "mermaid";
	if (ctx.method === "gpt-image") return "gpt-image";

	// 'auto': route by diagram type. Anything that has a clean structural
	// representation goes to Mermaid; freeform sketches and geometry go to
	// gpt-image (once implemented).
	const type = ctx.bbox.type.toLowerCase();
	const mermaidFriendly = new Set([
		"flowchart",
		"state_machine",
		"sequence_diagram",
		"mind_map",
		"tree",
		"class_diagram",
	]);
	if (mermaidFriendly.has(type)) return "mermaid";
	return "gpt-image";
}

async function runMermaid(ctx: RegenerationContext): Promise<RegeneratedDiagram> {
	const result = await generateMermaidFromImage(
		{
			croppedImage: ctx.croppedImage,
			description: ctx.bbox.description,
			suggestedType: ctx.bbox.type,
		},
		{ apiKey: ctx.apiKey, provider: ctx.provider },
	);

	return { payload: result.mermaidCode, usedStrategy: "mermaid" };
}