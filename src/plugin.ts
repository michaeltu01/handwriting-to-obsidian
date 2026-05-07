import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import { HandwrittenImportModal } from "./import-modal";
import {
	buildImportedNoteContent,
	extractMarkdownFromFile,
	extractMarkdownFromImages,
	inferNoteTitle,
	sanitizeFileNameSegment,
} from "./transcription";
import { NativeCameraModal } from "./native-camera";
import { DiagramDebugModal } from "./diagramDebugModal";
import { detectDiagrams, type DetectedDiagramBbox } from "./diagramDetection";
import { cropImage, denormalizeBbox, resizeImageForVision } from "./imageProcessing";
import { renderPdfPagesToImages } from "./pdfRendering";
import {
	appendUnreferencedDiagramBlocks,
	buildDiagramBlock,
	findRegenerableBlocks,
	listPlaceholderIds,
	rewriteBlockWithMermaid,
	rewriteBlockWithGptImage,
	substitutePlaceholders,
} from "./diagramPlaceholder";
import { regenerateDiagram } from "./diagramRegeneration";
import {
	API_KEY_SECRET_ID,
	detectProviderFromApiKey,
	DEFAULT_SETTINGS,
	getApiKeyValidationError as getStoredApiKeyValidationError,
	type HandwritingPluginSettings,
	type HandwritingProvider,
	HandwritingSettingTab,
	normalizeApiKeyInput,
} from "./settings";
import { getMimeTypeFromExtension, getUploadSelectionError, isPdfUpload } from "./upload";

export default class HandwritingToObsidianPlugin extends Plugin {
	settings!: HandwritingPluginSettings;
	private apiKey = "";

	async onload() {
		await this.loadSettings();
		this.refreshApiKeyFromSettings();

		this.addRibbonIcon("pen-tool", "Import handwritten note", () => {
			new HandwrittenImportModal(this.app, this).open();
		});

		this.addCommand({
			id: "import-handwritten-note",
			name: "Import handwritten note",
			callback: () => {
				new HandwrittenImportModal(this.app, this).open();
			},
		});

		this.addCommand({
			id: "capture-by-camera",
			name: "Capture handwritten note by camera",
			mobileOnly: true,
			callback: () => {
				new NativeCameraModal(this.app, this).open();
			},
		});

		this.addCommand({
			id: "debug-diagram-detection",
			name: "Debug: detect diagrams in an image",
			callback: () => {
				this.refreshApiKeyFromSettings();
				const provider = detectProviderFromApiKey(this.apiKey);
				if (!provider) {
					new Notice("Set an Anthropic or OpenAI API key in plugin settings first.");
					return;
				}
				new DiagramDebugModal(this.app, this.apiKey, provider).open();
			},
		});

		this.addCommand({
			id: "regenerate-diagrams",
			name: "Regenerate diagrams in this note",
			editorCheckCallback: (checking, _editor, view) => {
				const file = view.file;
				if (!file) return false;
				if (checking) return true;
				void this.regenerateDiagramsInNote(file);
				return true;
			},
		});

		this.addSettingTab(new HandwritingSettingTab(this.app, this));
	}

	getApiKeySecretId(): string {
		return this.settings.apiKeySecretId;
	}

	async setApiKeySecretId(secretId: string): Promise<void> {
		this.settings.apiKeySecretId = secretId.trim();
		await this.saveSettings();
		this.refreshApiKeyFromSettings();
	}

	getApiKeyValidationError(): string | null {
		this.refreshApiKeyFromSettings();
		return getStoredApiKeyValidationError(this.apiKey);
	}

	getResolvedOutputFolder(): string {
		return normalizePath(this.settings.outputFolder.trim() || DEFAULT_SETTINGS.outputFolder);
	}

	async importHandwrittenFile(file: File): Promise<TFile> {
		return await this.importHandwrittenFiles([file]);
	}

	/**
	 * Imports a list of handwritten files.
	 * NOTE: This is where the importing happens!
	 * @param files list of files to import
	 * @returns a Promise containing the Obsidian file
	 */
	async importHandwrittenFiles(files: File[]): Promise<TFile> {
		this.refreshApiKeyFromSettings();
		if (!this.apiKey) {
			throw new Error("Select an API key secret in the plugin settings before importing notes.");
		}
		if (files.length === 0) {
			throw new Error("Choose one PDF or at least one image before importing notes.");
		}

		const provider = this.getConfiguredProviderOrThrow();
		const selectionError = getUploadSelectionError(files);
		if (selectionError) {
			throw new Error(selectionError);
		}

		const { kind, markdown } = files.length === 1 && isPdfUpload(files[0])
			? await extractMarkdownFromFile(files[0], {
				apiKey: this.apiKey,
				provider,
			})
			: await extractMarkdownFromImages(files, {
				apiKey: this.apiKey,
				provider,
			});

		const title = inferNoteTitle(markdown, stripExtension(files[0].name));

		const folderPath = this.getResolvedOutputFolder();
		await this.ensureFolderExists(folderPath);

		const notePath = this.getAvailableNotePath(folderPath, sanitizeFileNameSegment(title));

		let sourcePaths: string[] = [];
		if (this.settings.includeOriginalDocument) {
			const savedAttachmentPaths: string[] = [];
			for (const file of files) {
				const attachmentPath = await this.app.fileManager.getAvailablePathForAttachment(file.name, notePath);
				const arrayBuffer = await file.arrayBuffer();
				const createdAttachment = await this.app.vault.createBinary(attachmentPath, arrayBuffer);
				savedAttachmentPaths.push(createdAttachment.path);
			}
			sourcePaths = savedAttachmentPaths;
		}

		// Replace <DIAGRAM_n> placeholders with crop embeds + regen-prompt callouts.
		// PDFs are rendered to page images first so they can use the same bbox
		// detection and crop pipeline as photo imports.
		const placeholderIds = listPlaceholderIds(markdown);
		let processedMarkdown = markdown;
		if (placeholderIds.length > 0 || kind === "pdf") {
			try {
				const diagramSourceFiles = kind === "pdf"
					? (await renderPdfPagesToImages(files[0])).map((page) => page.file)
					: files;

				processedMarkdown = await this.processDiagramsForImport({
					markdown,
					sourceFiles: diagramSourceFiles,
					notePath,
					provider,
					expectedDiagramCount: placeholderIds.length,
				});
			} catch (err) {
				console.warn(
					"Diagram detection failed during import; placeholders will remain as-is.",
					err,
				);
				new Notice("Diagram detection failed — note created without diagram crops.");
			}
		}

		const noteContent = buildImportedNoteContent({
			importedAt: new Date(),
			includeOriginalDocument: this.settings.includeOriginalDocument,
			markdown: processedMarkdown,
			provider,
			sourcePaths,
			sourceType: kind,
			title,
		});

		const createdFile = await this.app.vault.create(notePath, noteContent);

		if (this.settings.openAfterImport) {
			await this.app.workspace.getLeaf(true).openFile(createdFile);
		}

		return createdFile;
	}

	async importVaultFile(file: TFile): Promise<TFile> {
		return await this.importVaultFiles([file]);
	}

	async importVaultFiles(files: TFile[]): Promise<TFile> {
		const browserFiles = await Promise.all(files.map(async (vaultFile) => {
			const fileBinary = await this.app.vault.readBinary(vaultFile);
			const mimeType = getMimeTypeFromExtension(vaultFile.extension);
			return new File([fileBinary], vaultFile.name, {
				type: mimeType,
			});
		}));

		return await this.importHandwrittenFiles(browserFiles);
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData() as Partial<HandwritingPluginSettings>,
		);

		if (!this.settings.apiKeySecretId) {
			const legacyStoredValue = normalizeApiKeyInput(this.app.secretStorage.getSecret(API_KEY_SECRET_ID) ?? "");
			if (looksLikeSecretReference(legacyStoredValue)) {
				this.settings.apiKeySecretId = legacyStoredValue;
				await this.saveData(this.settings);
			}
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	openApiKeySettings(): void {
		const settingManager = (this.app as typeof this.app & {
			setting?: {
				open?: () => void;
				openTab?: (tab: unknown) => void;
				openTabById?: (id: string) => void;
				pluginTabs?: Record<string, unknown>;
			};
		}).setting;

		if (!settingManager?.open) {
			new Notice("Open Handwriting to Obsidian settings to update your API key.");
			return;
		}

		settingManager.open();

		if (typeof settingManager.openTabById === "function") {
			settingManager.openTabById(this.manifest.id);
			return;
		}

		const pluginTab = settingManager.pluginTabs?.[this.manifest.id];
		if (pluginTab && typeof settingManager.openTab === "function") {
			settingManager.openTab(pluginTab);
			return;
		}

		new Notice("Open Handwriting to Obsidian settings to update your API key.");
	}

	private getConfiguredProviderOrThrow() {
		const validationError = getStoredApiKeyValidationError(this.apiKey);
		if (validationError) {
			throw new Error(validationError);
		}

		const provider = detectProviderFromApiKey(this.apiKey);
		if (!provider) {
			throw new Error("Select an API key secret in the plugin settings before importing notes.");
		}

		return provider;
	}

	private refreshApiKeyFromSettings(): void {
		const secretId = this.settings.apiKeySecretId.trim();
		this.apiKey = normalizeApiKeyInput(
			secretId ? this.app.secretStorage.getSecret(secretId) ?? "" : "",
		);
	}

	private async ensureFolderExists(path: string): Promise<void> {
		const normalizedPath = normalizePath(path);
		if (!normalizedPath) {
			return;
		}

		const existing = this.app.vault.getAbstractFileByPath(normalizedPath);
		if (existing) {
			return;
		}

		let currentPath = "";
		for (const segment of normalizedPath.split("/")) {
			currentPath = currentPath ? `${currentPath}/${segment}` : segment;
			if (!this.app.vault.getAbstractFileByPath(currentPath)) {
				await this.app.vault.createFolder(currentPath);
			}
		}
	}

	private getAvailableNotePath(folderPath: string, preferredName: string): string {
		const safeBaseName = preferredName || "Imported note";
		let suffix = 0;

		while (true) {
			const fileName = suffix === 0 ? `${safeBaseName}.md` : `${safeBaseName} ${suffix}.md`;
			const candidatePath = normalizePath(`${folderPath}/${fileName}`);
			if (!this.app.vault.getAbstractFileByPath(candidatePath)) {
				return candidatePath;
			}

			suffix += 1;
		}
	}

	/**
	 * Runs detection on each source image, crops every detected diagram,
	 * saves crops as attachments, and replaces <DIAGRAM_n> placeholders in the
	 * markdown with image embeds plus the regen-prompt callout.
	 *
	 * Numbering rule: diagrams are numbered globally across all source pages
	 * in the order pages were uploaded. This matches the transcription prompt
	 * which numbers placeholders the same way.
	 */
	private async processDiagramsForImport(args: {
		markdown: string;
		sourceFiles: File[];
		notePath: string;
		provider: HandwritingProvider;
		expectedDiagramCount?: number;
	}): Promise<string> {
		const { markdown, sourceFiles, notePath, provider, expectedDiagramCount } = args;

		const blocksById = new Map<number, string>();
		let nextDiagramId = 1;
		const preparedSources: Array<{
			sourceFile: File;
			resized: Awaited<ReturnType<typeof resizeImageForVision>>;
		}> = [];

		for (const sourceFile of sourceFiles) {
			const resized = await resizeImageForVision(sourceFile, { mimeType: "image/png" });
			preparedSources.push({ sourceFile, resized });
		}

		let detections = await this.detectDiagramsForPreparedSources(preparedSources, provider);
		const detectedCount = countDetectedDiagrams(detections);
		if (expectedDiagramCount && detectedCount < expectedDiagramCount) {
			const retryDetections = await this.detectDiagramsForPreparedSources(
				preparedSources,
				provider,
				{
					expectedDiagramCount,
					mode: "lenient",
				},
			);
			if (countDetectedDiagrams(retryDetections) > detectedCount) {
				detections = retryDetections;
			}
		}

		for (const detection of detections) {
			const { sourceFile, resized } = detection;

			for (const bbox of refineDiagramBboxes(detection.diagrams.diagrams)) {
				const id = nextDiagramId++;
				const cropFile = await this.cropAndSaveDiagram({
					sourceFile,
					originalWidth: resized.originalWidth,
					originalHeight: resized.originalHeight,
					bbox,
					notePath,
					id,
				});
				if (!cropFile) continue;

				blocksById.set(id, buildDiagramBlock({
					id,
					imageVaultPath: cropFile.path,
				}));
			}
		}

		return appendUnreferencedDiagramBlocks(
			substitutePlaceholders(markdown, blocksById),
			blocksById,
			markdown,
		);
	}

	private async detectDiagramsForPreparedSources(
		preparedSources: Array<{
			sourceFile: File;
			resized: Awaited<ReturnType<typeof resizeImageForVision>>;
		}>,
		provider: HandwritingProvider,
		options: {
			expectedDiagramCount?: number;
			mode?: "default" | "lenient";
		} = {},
	): Promise<Array<{
		sourceFile: File;
		resized: Awaited<ReturnType<typeof resizeImageForVision>>;
		diagrams: Awaited<ReturnType<typeof detectDiagrams>>;
	}>> {
		const results: Array<{
			sourceFile: File;
			resized: Awaited<ReturnType<typeof resizeImageForVision>>;
			diagrams: Awaited<ReturnType<typeof detectDiagrams>>;
		}> = [];

		for (const prepared of preparedSources) {
			const diagrams = await detectDiagrams(prepared.resized.file, {
				apiKey: this.apiKey,
				provider,
				expectedDiagramCount: options.expectedDiagramCount,
				mode: options.mode,
			});
			results.push({ ...prepared, diagrams });
		}

		return results;
	}

	/**
	 * Crops a bbox out of the original (full-resolution) source image and writes
	 * it to the vault as a PNG attachment. Returns the created TFile, or null
	 * if the crop failed.
	 *
	 * The crop is written to an `attachments/` subfolder next to the note, so
	 * imported diagrams stay grouped with their note instead of leaking into
	 * whatever global attachment folder the user has configured.
	 *
	 * We pad the bbox by 8% on each side before cropping. Vision models are
	 * not reliably tight or accurate on bbox edges, especially on busy pages
	 * with multiple regions. Padding is cheap insurance: a slightly oversized
	 * crop is harmless for both viewing and downstream Mermaid generation,
	 * but a too-tight crop can lose nodes from the diagram entirely.
	 */
	private async cropAndSaveDiagram(args: {
		sourceFile: File;
		originalWidth: number;
		originalHeight: number;
		bbox: DetectedDiagramBbox;
		notePath: string;
		id: number;
	}): Promise<TFile | null> {
		const { sourceFile, originalWidth, originalHeight, bbox, notePath, id } = args;

		const pixelBox = denormalizeBbox(bbox.bbox, originalWidth, originalHeight);
		if (pixelBox.width <= 0 || pixelBox.height <= 0) return null;

		const paddedBox = expandDiagramCropBbox(pixelBox, bbox, originalWidth, originalHeight);

		const cropFile = await cropImage(sourceFile, paddedBox, {
			mimeType: "image/png",
			filenameSuffix: `diagram-${id}`,
		});

		// Place the crop next to the note in `<note-folder>/attachments/`.
		const noteFolder = notePath.substring(0, notePath.lastIndexOf("/"));
		const attachmentsFolder = noteFolder
			? normalizePath(`${noteFolder}/attachments`)
			: "attachments";
		await this.ensureFolderExists(attachmentsFolder);

		const attachmentPath = this.getAvailableAttachmentPath(attachmentsFolder, cropFile.name);
		const buffer = await cropFile.arrayBuffer();
		return await this.app.vault.createBinary(attachmentPath, buffer);
	}

	/**
	 * Returns a vault path inside `folder` that does not yet exist, by appending
	 * a numeric suffix if needed. Mirrors getAvailablePathForAttachment but lets
	 * us choose the folder ourselves.
	 */
	private getAvailableAttachmentPath(folder: string, fileName: string): string {
		const dotIndex = fileName.lastIndexOf(".");
		const base = dotIndex === -1 ? fileName : fileName.substring(0, dotIndex);
		const ext = dotIndex === -1 ? "" : fileName.substring(dotIndex);

		let suffix = 0;
		while (true) {
			const candidateName = suffix === 0 ? `${base}${ext}` : `${base} ${suffix}${ext}`;
			const candidatePath = normalizePath(`${folder}/${candidateName}`);
			if (!this.app.vault.getAbstractFileByPath(candidatePath)) {
				return candidatePath;
			}
			suffix += 1;
		}
	}

	/**
	 * Walks every regenerable diagram block in the active note and replaces
	 * its callout with a Mermaid code block (or other strategy output).
	 * The original image embed is preserved.
	 */
	private async regenerateDiagramsInNote(file: TFile): Promise<void> {
		this.refreshApiKeyFromSettings();
		const provider = detectProviderFromApiKey(this.apiKey);
		if (!this.apiKey || !provider) {
			new Notice("Set an Anthropic or OpenAI API key in plugin settings first.");
			return;
		}

		const original = await this.app.vault.read(file);
		const blocks = findRegenerableBlocks(original);
		if (blocks.length === 0) {
			new Notice("No regenerable diagrams found in this note.");
			return;
		}

		new Notice(`Regenerating ${blocks.length} diagram(s)...`);

		// Walk blocks back-to-front so earlier replacements don't shift later indexes.
		let updated = original;
		for (let i = blocks.length - 1; i >= 0; i--) {
			const block = blocks[i];
			try {
				const cropFile = this.resolveImageEmbed(block.imageLine, file);
				if (!cropFile) {
					console.warn(`Could not resolve image embed for diagram ${block.id}.`);
					continue;
				}
				const cropBytes = await this.app.vault.readBinary(cropFile);
				const cropImageFile = new File([cropBytes], cropFile.name, { type: "image/png" });

				// Detection metadata isn't persisted in the note, so we synthesize a
				// minimal bbox stub. The cropped image alone gives the regenerator
				// enough to work with; description/type are best-effort defaults.
				const stubBbox: DetectedDiagramBbox = {
					id: block.id,
					bbox: { x_min: 0, y_min: 0, x_max: 1000, y_max: 1000 },
					type: "flowchart",
					description: "Hand-drawn diagram from imported note.",
				};

				const regen = await regenerateDiagram({
					croppedImage: cropImageFile,
					bbox: stubBbox,
					apiKey: this.apiKey,
					provider,
					method: this.settings.diagramRegenerationMethod,
				});

				let newBlock: string;
				if (regen.usedStrategy === "mermaid") {
					newBlock = rewriteBlockWithMermaid(block, regen.mermaidCode);
				} else {
					// Save the generated PNG next to the note in the same attachments
					// folder used during import, then build a second image embed.
					const noteFolder = file.parent ? file.parent.path : "";
					const attachmentsFolder = noteFolder
						? normalizePath(`${noteFolder}/attachments`)
						: "attachments";
					await this.ensureFolderExists(attachmentsFolder);

					const baseName = stripExtension(file.name);
					const generatedFileName = `${baseName}-diagram-${block.id}-regen.png`;
					const generatedPath = this.getAvailableAttachmentPath(
						attachmentsFolder,
						generatedFileName,
					);
					const buffer = regen.pngBytes.slice().buffer;
					await this.app.vault.createBinary(generatedPath, buffer);

					const generatedEmbedName = generatedPath.split("/").pop() ?? generatedFileName;
					const embedLine = `![[${generatedEmbedName}]]`;
					newBlock = rewriteBlockWithGptImage(block, embedLine);
				}
				updated = updated.slice(0, block.startIndex) + newBlock + updated.slice(block.endIndex);
			} catch (err) {
				console.warn(`Regeneration failed for diagram ${block.id}:`, err);
				new Notice(`Regeneration failed for diagram ${block.id}. See console.`);
			}
		}

		if (updated !== original) {
			await this.app.vault.modify(file, updated);
			new Notice("Diagram regeneration complete.");
		}
	}

	/**
	 * Resolves an Obsidian image embed line like `![[name.png]]` to the actual
	 * TFile in the vault. Returns null if the file cannot be found.
	 */
	private resolveImageEmbed(imageLine: string, sourceNote: TFile): TFile | null {
		const match = imageLine.match(/^!\[\[([^\]]+)\]\]$/);
		if (!match) return null;
		const linkText = match[1].split("|")[0].trim();
		const resolved = this.app.metadataCache.getFirstLinkpathDest(linkText, sourceNote.path);
		if (resolved instanceof TFile) return resolved;
		return null;
	}
}

function stripExtension(fileName: string): string {
	return fileName.replace(/\.[^/.]+$/, "");
}

function looksLikeSecretReference(value: string): boolean {
	return value.length > 0
		&& !detectProviderFromApiKey(value)
		&& /^[a-z0-9][a-z0-9-_]*$/i.test(value);
}

function countDetectedDiagrams(
	detections: Array<{ diagrams: Awaited<ReturnType<typeof detectDiagrams>> }>,
): number {
	return detections.reduce((sum, detection) => sum + detection.diagrams.diagrams.length, 0);
}

function refineDiagramBboxes(diagrams: DetectedDiagramBbox[]): DetectedDiagramBbox[] {
	const filtered = diagrams.filter((diagram) => !isLikelyStandaloneTextStrip(diagram));
	return mergeNearbyDiagramBboxes(filtered);
}

function isLikelyStandaloneTextStrip(diagram: DetectedDiagramBbox): boolean {
	const { bbox } = diagram;
	const width = bbox.x_max - bbox.x_min;
	const height = bbox.y_max - bbox.y_min;
	if (width < 520 || height > 170) {
		return false;
	}

	const text = `${diagram.type} ${diagram.description}`.toLowerCase();
	const hasStructuralCue = /\b(protocol|interaction|communication|sequence|participant|alice|bob|client|server|message|node|box|circle|stick|flow|chart|table|axis|sketch|tree|branch|state|mind map)\b/.test(text);
	if (hasStructuralCue) {
		return false;
	}

	const hasTextOnlyCue = /\b(text|formula|equation|caption|heading|paragraph|definition|line|sentence)\b/.test(text);
	return hasTextOnlyCue || height < 120;
}

function mergeNearbyDiagramBboxes(diagrams: DetectedDiagramBbox[]): DetectedDiagramBbox[] {
	let merged = diagrams
		.map(normalizeDiagramBbox)
		.filter((diagram) => diagram.bbox.x_max > diagram.bbox.x_min && diagram.bbox.y_max > diagram.bbox.y_min)
		.sort(compareDiagramPosition);

	let changed = true;
	while (changed) {
		changed = false;
		const next: DetectedDiagramBbox[] = [];

		for (const diagram of merged) {
			const index = next.findIndex((candidate) => shouldMergeDiagramBboxes(candidate, diagram));
			if (index === -1) {
				next.push(diagram);
			} else {
				next[index] = mergeDiagramBboxPair(next[index], diagram);
				changed = true;
			}
		}

		merged = next.sort(compareDiagramPosition);
	}

	return merged.map((diagram, index) => ({ ...diagram, id: index + 1 }));
}

function shouldMergeDiagramBboxes(a: DetectedDiagramBbox, b: DetectedDiagramBbox): boolean {
	const ab = a.bbox;
	const bb = b.bbox;
	const xOverlap = Math.max(0, Math.min(ab.x_max, bb.x_max) - Math.max(ab.x_min, bb.x_min));
	const yOverlap = Math.max(0, Math.min(ab.y_max, bb.y_max) - Math.max(ab.y_min, bb.y_min));
	const minWidth = Math.min(ab.x_max - ab.x_min, bb.x_max - bb.x_min);
	const minHeight = Math.min(ab.y_max - ab.y_min, bb.y_max - bb.y_min);
	const xOverlapRatio = minWidth > 0 ? xOverlap / minWidth : 0;
	const yOverlapRatio = minHeight > 0 ? yOverlap / minHeight : 0;
	const verticalGap = Math.max(0, Math.max(ab.y_min, bb.y_min) - Math.min(ab.y_max, bb.y_max));
	const horizontalGap = Math.max(0, Math.max(ab.x_min, bb.x_min) - Math.min(ab.x_max, bb.x_max));
	const unionHeight = Math.max(ab.y_max, bb.y_max) - Math.min(ab.y_min, bb.y_min);
	const unionWidth = Math.max(ab.x_max, bb.x_max) - Math.min(ab.x_min, bb.x_min);

	if (xOverlapRatio >= 0.35 && yOverlapRatio >= 0.35) {
		return true;
	}

	const relatedText = `${a.type} ${a.description} ${b.type} ${b.description}`.toLowerCase();
	const protocolLike = /\b(protocol|interaction|communication|sequence|participant|alice|bob|client|server|message|stick)\b/.test(relatedText);
	const stripLike = isWideShortBbox(a) || isWideShortBbox(b);

	if (xOverlapRatio >= 0.28 && verticalGap <= (protocolLike || stripLike ? 115 : 65) && unionHeight <= 460) {
		return true;
	}

	if (yOverlapRatio >= 0.28 && horizontalGap <= 80 && unionWidth <= 980) {
		return true;
	}

	return false;
}

function mergeDiagramBboxPair(a: DetectedDiagramBbox, b: DetectedDiagramBbox): DetectedDiagramBbox {
	return {
		id: Math.min(a.id, b.id),
		bbox: {
			x_min: Math.min(a.bbox.x_min, b.bbox.x_min),
			y_min: Math.min(a.bbox.y_min, b.bbox.y_min),
			x_max: Math.max(a.bbox.x_max, b.bbox.x_max),
			y_max: Math.max(a.bbox.y_max, b.bbox.y_max),
		},
		type: chooseMergedDiagramType(a.type, b.type),
		description: [a.description, b.description].filter(Boolean).join(" "),
	};
}

function chooseMergedDiagramType(a: string, b: string): string {
	if (a === b) return a;
	const combined = `${a} ${b}`.toLowerCase();
	if (/\b(protocol|interaction|communication|sequence)\b/.test(combined)) {
		return "interaction_diagram";
	}
	if (combined.includes("table")) return "table";
	if (combined.includes("flow")) return "flowchart";
	return a || b || "unknown";
}

function normalizeDiagramBbox(diagram: DetectedDiagramBbox): DetectedDiagramBbox {
	const xMin = clampNumber(Math.round(diagram.bbox.x_min), 0, 1000);
	const yMin = clampNumber(Math.round(diagram.bbox.y_min), 0, 1000);
	const xMax = clampNumber(Math.round(diagram.bbox.x_max), 0, 1000);
	const yMax = clampNumber(Math.round(diagram.bbox.y_max), 0, 1000);
	return {
		...diagram,
		bbox: {
			x_min: Math.min(xMin, xMax),
			y_min: Math.min(yMin, yMax),
			x_max: Math.max(xMin, xMax),
			y_max: Math.max(yMin, yMax),
		},
	};
}

function compareDiagramPosition(a: DetectedDiagramBbox, b: DetectedDiagramBbox): number {
	const y = a.bbox.y_min - b.bbox.y_min;
	return Math.abs(y) > 25 ? y : a.bbox.x_min - b.bbox.x_min;
}

function isWideShortBbox(diagram: DetectedDiagramBbox): boolean {
	const width = diagram.bbox.x_max - diagram.bbox.x_min;
	const height = diagram.bbox.y_max - diagram.bbox.y_min;
	return width >= 520 && height <= 220;
}

/**
 * Expands model bboxes before cropping. Detection models often return tight
 * horizontal strips for handwritten protocol diagrams; a larger crop is much
 * more useful for later regeneration than a precise but incomplete crop.
 */
function expandDiagramCropBbox(
	bbox: { x: number; y: number; width: number; height: number },
	diagram: DetectedDiagramBbox,
	imageWidth: number,
	imageHeight: number,
): { x: number; y: number; width: number; height: number } {
	const text = `${diagram.type} ${diagram.description}`.toLowerCase();
	const protocolLike = /\b(protocol|interaction|communication|sequence|participant|alice|bob|client|server|message|stick)\b/.test(text);
	const stripLike = bbox.width / imageWidth > 0.45 && bbox.height / imageHeight < 0.24;
	const padXFraction = protocolLike ? 0.2 : 0.16;
	const padYFraction = protocolLike || stripLike ? 0.55 : 0.25;

	const padded = padBbox(bbox, padXFraction, padYFraction, imageWidth, imageHeight);
	const minWidth = protocolLike ? imageWidth * 0.62 : stripLike ? imageWidth * 0.55 : 0;
	const minHeight = protocolLike ? imageHeight * 0.3 : stripLike ? imageHeight * 0.26 : 0;
	return ensureMinBboxSize(padded, minWidth, minHeight, imageWidth, imageHeight);
}

function padBbox(
	bbox: { x: number; y: number; width: number; height: number },
	fractionX: number,
	fractionY: number,
	imageWidth: number,
	imageHeight: number,
): { x: number; y: number; width: number; height: number } {
	const padX = bbox.width * fractionX;
	const padY = bbox.height * fractionY;

	const x = Math.max(0, bbox.x - padX);
	const y = Math.max(0, bbox.y - padY);
	const right = Math.min(imageWidth, bbox.x + bbox.width + padX);
	const bottom = Math.min(imageHeight, bbox.y + bbox.height + padY);

	return {
		x,
		y,
		width: right - x,
		height: bottom - y,
	};
}

function ensureMinBboxSize(
	bbox: { x: number; y: number; width: number; height: number },
	minWidth: number,
	minHeight: number,
	imageWidth: number,
	imageHeight: number,
): { x: number; y: number; width: number; height: number } {
	const width = Math.min(imageWidth, Math.max(bbox.width, minWidth));
	const height = Math.min(imageHeight, Math.max(bbox.height, minHeight));
	const centerX = bbox.x + bbox.width / 2;
	const centerY = bbox.y + bbox.height / 2;
	const x = clampNumber(centerX - width / 2, 0, imageWidth - width);
	const y = clampNumber(centerY - height / 2, 0, imageHeight - height);

	return { x, y, width, height };
}

function clampNumber(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
