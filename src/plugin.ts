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
import {
	buildDiagramBlock,
	findRegenerableBlocks,
	listPlaceholderIds,
	rewriteBlockWithMermaid,
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
		// We only do this for image inputs; PDFs go through a different transcription
		// path and we don't have per-page detection wired up for them yet.
		const placeholderIds = listPlaceholderIds(markdown);
		let processedMarkdown = markdown;
		if (kind === "image" && placeholderIds.length > 0) {
			try {
				processedMarkdown = await this.processDiagramsForImport({
					markdown,
					sourceFiles: files,
					notePath,
					provider,
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
	}): Promise<string> {
		const { markdown, sourceFiles, notePath, provider } = args;

		const blocksById = new Map<number, string>();
		let nextDiagramId = 1;

		for (const sourceFile of sourceFiles) {
			const resized = await resizeImageForVision(sourceFile, { mimeType: "image/png" });
			const detection = await detectDiagrams(resized.file, {
				apiKey: this.apiKey,
				provider,
			});

			for (const bbox of detection.diagrams) {
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

		return substitutePlaceholders(markdown, blocksById);
	}

	/**
	 * Crops a bbox out of the original (full-resolution) source image and writes
	 * it to the vault as a PNG attachment. Returns the created TFile, or null
	 * if the crop failed.
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

		const cropFile = await cropImage(sourceFile, pixelBox, {
			mimeType: "image/png",
			filenameSuffix: `diagram-${id}`,
		});

		const attachmentPath = await this.app.fileManager.getAvailablePathForAttachment(
			cropFile.name,
			notePath,
		);
		const buffer = await cropFile.arrayBuffer();
		return await this.app.vault.createBinary(attachmentPath, buffer);
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

				const newBlock = rewriteBlockWithMermaid(block, regen.payload);
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