import { App, type EventRef, Modal, Notice, Platform, Plugin, setIcon, TAbstractFile, TFile, normalizePath } from "obsidian";
import {
	buildImportedNoteContent,
	extractMarkdownFromFile,
	extractMarkdownFromImages,
	inferNoteTitle,
	sanitizeFileNameSegment,
} from "./transcription";
import {
	API_KEY_SECRET_ID,
	detectProviderFromApiKey,
	DEFAULT_SETTINGS,
	getApiKeyValidationError,
	type HandwritingPluginSettings,
	HandwritingSettingTab,
	normalizeApiKeyInput,
} from "./settings";

const CAMERA_PLUGIN_ID = "obsidian-camera";
const CAMERA_PLUGIN_COMMAND_ID = `${CAMERA_PLUGIN_ID}:Open camera modal`;
const CAMERA_CAPTURE_TIMEOUT_MS = 2 * 60 * 1000;
const CAMERA_CAPTURE_IDLE_MS = 6 * 1000;
const DEFAULT_CAMERA_PLUGIN_FOLDER = "attachments/snaps";

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
			id: "capture-handwritten-note-with-camera",
			name: "Capture handwritten note with Camera plugin",
			mobileOnly: true,
			callback: () => {
				void this.captureWithCameraPluginAndImport();
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
		return getApiKeyValidationError(this.apiKey);
	}

	getResolvedOutputFolder(): string {
		return normalizePath(this.settings.outputFolder.trim() || DEFAULT_SETTINGS.outputFolder);
	}

	async importHandwrittenFile(file: File): Promise<TFile> {
		return await this.importHandwrittenFiles([file]);
	}

	async importHandwrittenFiles(files: File[]): Promise<TFile> {
		this.refreshApiKeyFromSettings();
		if (!this.apiKey) {
			throw new Error("Set an API key in the plugin settings before importing notes.");
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
		const noteContent = buildImportedNoteContent({
			importedAt: new Date(),
			markdown,
			provider,
			sourceNames: files.map((file) => file.name),
			sourceType: kind,
			title,
		});

		const folderPath = this.getResolvedOutputFolder();
		await this.ensureFolderExists(folderPath);

		const notePath = this.getAvailableNotePath(folderPath, sanitizeFileNameSegment(title));
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

	hasCameraPluginInstalled(): boolean {
		const plugins = (this.app as any).plugins?.plugins as Record<string, unknown> | undefined;
		return Boolean(plugins?.[CAMERA_PLUGIN_ID]);
	}

	getCameraPluginCaptureFolder(): string {
		const cameraPlugin = (this.app as any).plugins?.plugins?.[CAMERA_PLUGIN_ID] as
			| { settings?: { chosenFolderPath?: string } }
			| undefined;

		return normalizePath(
			cameraPlugin?.settings?.chosenFolderPath?.trim() || DEFAULT_CAMERA_PLUGIN_FOLDER,
		);
	}

	getCameraPluginCommandId(): string | null {
		const commandRegistry = (this.app as any).commands?.commands as Record<string, { id: string; name?: string }> | undefined;
		if (!commandRegistry) {
			return null;
		}

		if (commandRegistry[CAMERA_PLUGIN_COMMAND_ID]) {
			return CAMERA_PLUGIN_COMMAND_ID;
		}

		const candidates = Object.values(commandRegistry)
			.filter((command) => isCameraPluginCommand(command))
			.sort((left, right) => getCameraCommandScore(right) - getCameraCommandScore(left));

		return candidates[0]?.id ?? null;
	}

	async captureWithCameraPluginAndImport(): Promise<TFile> {
		this.refreshApiKeyFromSettings();
		if (!this.apiKey) {
			throw new Error("Set an API key in the plugin settings before importing notes.");
		}
		this.getConfiguredProviderOrThrow();

		const commandId = this.getCameraPluginCommandId();
		if (!commandId) {
			throw new Error("Could not find an Obsidian Camera command. Install and enable the Camera plugin first.");
		}

		new Notice("Open Obsidian Camera and take one or more photos. Import starts a few seconds after the last image is saved.");
		const capturedImages = await this.captureImagesWithCameraPlugin(
			commandId,
			this.getCameraPluginCaptureFolder(),
		);
		new Notice(`Captured ${capturedImages.length} image${capturedImages.length === 1 ? "" : "s"}. Transcribing note...`);

		return await this.importVaultFiles(capturedImages);
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
		const settingManager = (this.app as any).setting as
			| {
				open?: () => void;
				openTab?: (tab: unknown) => void;
				openTabById?: (id: string) => void;
				pluginTabs?: Record<string, unknown>;
			}
			| undefined;

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
		const validationError = getApiKeyValidationError(this.apiKey);
		if (validationError) {
			throw new Error(validationError);
		}

		const provider = detectProviderFromApiKey(this.apiKey);
		if (!provider) {
			throw new Error("Set an API key in the plugin settings before importing notes.");
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

	private async captureImagesWithCameraPlugin(commandId: string, captureFolder: string): Promise<TFile[]> {
		const commandManager = (this.app as any).commands as { executeCommandById?: (id: string) => boolean | void } | undefined;
		const executeCommandById = commandManager?.executeCommandById;
		if (!executeCommandById) {
			throw new Error("Obsidian command execution is unavailable.");
		}

		const startedAt = Date.now();
		let timeoutId = 0;
		let idleTimeoutId = 0;
		let completed = false;
		let eventRef: EventRef | null = null;
		const capturedFiles = new Map<string, TFile>();

		return await new Promise<TFile[]>((resolve, reject) => {
			const cleanup = () => {
				if (eventRef) {
					this.app.vault.offref(eventRef);
				}
				if (timeoutId) {
					window.clearTimeout(timeoutId);
				}
				if (idleTimeoutId) {
					window.clearTimeout(idleTimeoutId);
				}
			};

			const finishCapture = () => {
				if (completed) {
					return;
				}

				completed = true;
				cleanup();
				const orderedFiles = Array.from(capturedFiles.values())
					.sort((left, right) => left.stat.ctime - right.stat.ctime);
				resolve(orderedFiles);
			};

			const scheduleIdleFinish = () => {
				if (idleTimeoutId) {
					window.clearTimeout(idleTimeoutId);
				}

				idleTimeoutId = window.setTimeout(() => {
					if (capturedFiles.size === 0) {
						return;
					}

					finishCapture();
				}, CAMERA_CAPTURE_IDLE_MS);
			};

			eventRef = this.app.vault.on("create", (abstractFile: TAbstractFile) => {
				if (!(abstractFile instanceof TFile)) {
					return;
				}

				if (!isSupportedCapturedImage(abstractFile)) {
					return;
				}

				if (!isInsideCameraCaptureFolder(abstractFile, captureFolder)) {
					return;
				}

				if (abstractFile.stat.ctime + 1000 < startedAt) {
					return;
				}

				capturedFiles.set(abstractFile.path, abstractFile);
				scheduleIdleFinish();
			});

			timeoutId = window.setTimeout(() => {
				if (completed) {
					return;
				}

				if (capturedFiles.size > 0) {
					finishCapture();
					return;
				}

				cleanup();
				reject(new Error("Timed out waiting for captured images from the Camera plugin."));
			}, CAMERA_CAPTURE_TIMEOUT_MS);

			try {
				const result = executeCommandById(commandId);
				if (result === false) {
					cleanup();
					reject(new Error("Failed to open the Camera plugin command."));
				}
			} catch (error) {
				cleanup();
				reject(error instanceof Error ? error : new Error("Failed to run the Camera plugin command."));
			}
		});
	}
}

class HandwrittenImportModal extends Modal {
	private selectedFiles: File[] = [];
	private readonly plugin: HandwritingToObsidianPlugin;
	private statusEl!: HTMLDivElement;
	private selectedSectionEl!: HTMLDivElement;
	private selectedFileCardEl!: HTMLDivElement;
	private selectedFileIconEl!: HTMLDivElement;
	private selectedFileNameEl!: HTMLDivElement;
	private selectedFileMetaEl!: HTMLDivElement;
	private convertButtonEl!: HTMLButtonElement;
	private convertButtonLabelEl!: HTMLSpanElement;
	private convertButtonIconEl!: HTMLSpanElement;
	private updateApiKeyButtonEl!: HTMLButtonElement;
	private imageButtonEl!: HTMLButtonElement;
	private cameraButtonEl: HTMLButtonElement | null = null;
	private imageInputEl!: HTMLInputElement;
	private isProcessing = false;

	constructor(app: App, plugin: HandwritingToObsidianPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("hto-modal-content");
		this.modalEl.addClass("hto-modal-shell");

		const shell = contentEl.createDiv({ cls: "hto-import-modal" });
		const heroEl = shell.createDiv({ cls: "hto-hero" });
		heroEl.createEl("h2", {
			cls: "hto-title",
			text: "Import handwritten note",
		});
		heroEl.createEl("p", {
			cls: "hto-description",
			text: "Choose one PDF or one or more note images and turn them into a Markdown note.",
		});

		const sourceSectionEl = shell.createDiv({ cls: "hto-section" });
		const sourceGridEl = sourceSectionEl.createDiv({ cls: "hto-source-grid" });

		if (Platform.isMobileApp && this.plugin.hasCameraPluginInstalled()) {
			this.cameraButtonEl = createSourceCard(sourceGridEl, {
				description: "Take one or more photos. Import starts after the last saved image.",
				icon: "camera",
				modifierClass: "is-camera",
				title: "Take photo",
			});
			this.cameraButtonEl.addEventListener("click", () => void this.handleCameraCapture());
		}

		this.imageInputEl = contentEl.createEl("input", { type: "file" });
		this.imageInputEl.accept = "image/*,.pdf,application/pdf";
		this.imageInputEl.multiple = true;
		this.imageInputEl.style.display = "none";

		this.imageButtonEl = createSourceCard(sourceGridEl, {
			description: "Photo, scan, screenshot, gallery images, or a PDF.",
			icon: "files",
			title: "Choose files",
		});
		if (sourceGridEl.childElementCount === 1 || this.cameraButtonEl) {
			sourceGridEl.addClass("is-single-column");
		}

		this.selectedSectionEl = shell.createDiv({ cls: "hto-section hto-selected-section is-hidden" });
		this.selectedFileCardEl = this.selectedSectionEl.createDiv({
			cls: "hto-selected-file-card",
		});
		this.selectedFileIconEl = this.selectedFileCardEl.createDiv({
			cls: "hto-selected-file-icon",
		});
		setIcon(this.selectedFileIconEl, "file");
		const selectedFileBodyEl = this.selectedFileCardEl.createDiv({
			cls: "hto-selected-file-body",
		});
		this.selectedFileNameEl = selectedFileBodyEl.createDiv({
			cls: "hto-selected-file-name",
			text: "",
		});
		this.selectedFileMetaEl = selectedFileBodyEl.createDiv({
			cls: "hto-selected-file-meta",
			text: "",
		});

		this.statusEl = shell.createDiv({
			cls: "hto-status is-hidden",
		});

		const footerEl = shell.createDiv({ cls: "hto-footer" });
		const footerMetaEl = footerEl.createDiv({ cls: "hto-footer-meta" });
		this.updateApiKeyButtonEl = footerMetaEl.createEl("button", {
			attr: { type: "button" },
			cls: "hto-secondary-button hto-settings-button",
			text: "Update API key",
		});
		const footerActionsEl = footerEl.createDiv({ cls: "hto-footer-actions" });
		this.convertButtonEl = footerActionsEl.createEl("button", {
			attr: { type: "button" },
			cls: "mod-cta hto-primary-button",
		});
		this.convertButtonIconEl = this.convertButtonEl.createSpan({
			cls: "hto-button-icon",
		});
		this.convertButtonLabelEl = this.convertButtonEl.createSpan({
			cls: "hto-button-label",
			text: "Convert to Markdown",
		});
		setIcon(this.convertButtonIconEl, "wand");

		this.imageButtonEl.addEventListener("click", () => this.imageInputEl.click());
		this.imageInputEl.addEventListener("change", () => this.handleFileSelection(this.imageInputEl.files));
		this.updateApiKeyButtonEl.addEventListener("click", () => {
			this.close();
			this.plugin.openApiKeySettings();
		});
		this.convertButtonEl.addEventListener("click", () => void this.handleConvert());

		this.updateActions();
	}

	onClose() {
		this.contentEl.removeClass("hto-modal-content");
		this.modalEl.removeClass("hto-modal-shell");
		this.contentEl.empty();
	}

	private handleFileSelection(files: FileList | null): void {
		this.selectedFiles = files ? Array.from(files) : [];
		const selectionError = getUploadSelectionError(this.selectedFiles);
		if (this.selectedFiles.length === 0) {
			this.updateSelectedFileState();
			this.setStatus("", "neutral");
			this.updateActions();
			return;
		}

		this.updateSelectedFileState();
		this.setStatus(selectionError ?? "", selectionError ? "error" : "neutral");
		this.updateActions();
	}

	private async handleConvert(): Promise<void> {
		if (this.selectedFiles.length === 0 || this.isProcessing) {
			return;
		}

		const apiKeyValidationError = this.plugin.getApiKeyValidationError();
		if (apiKeyValidationError) {
			const message = apiKeyValidationError;
			this.setStatus(message, "error");
			new Notice(message);
			return;
		}

		const selectionError = getUploadSelectionError(this.selectedFiles);
		if (selectionError) {
			this.setStatus(selectionError, "error");
			new Notice(selectionError);
			return;
		}

		this.isProcessing = true;
		this.setStatus("Transcribing note and generating Markdown…", "loading");
		this.updateActions();

		try {
			const createdFile = await this.plugin.importHandwrittenFiles(this.selectedFiles);
			this.setStatus(`Created ${createdFile.name}`, "success");
			new Notice(`Created ${createdFile.path}`);
			this.close();
		} catch (error) {
			const message = error instanceof Error ? error.message : "Failed to transcribe note.";
			console.error("Handwriting to Obsidian import failed", error);
			this.setStatus(message, "error");
			new Notice(message);
			this.isProcessing = false;
			this.updateActions();
		}
	}

	private async handleCameraCapture(): Promise<void> {
		if (this.isProcessing) {
			return;
		}

		const apiKeyValidationError = this.plugin.getApiKeyValidationError();
		if (apiKeyValidationError) {
			const message = apiKeyValidationError;
			this.setStatus(message, "error");
			new Notice(message);
			return;
		}

		this.isProcessing = true;
		this.setStatus("Opening Obsidian Camera…", "loading");
		this.updateActions();
		this.close();

		try {
			const createdFile = await this.plugin.captureWithCameraPluginAndImport();
			new Notice(`Created ${createdFile.path}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Failed to capture note with the Camera plugin.";
			console.error("Handwriting to Obsidian camera capture failed", error);
			new Notice(message);
		}
	}

	private updateActions(): void {
		const disabled = this.isProcessing;
		const selectionError = getUploadSelectionError(this.selectedFiles);
		if (this.cameraButtonEl) {
			this.cameraButtonEl.disabled = disabled;
		}
		this.imageButtonEl.classList.toggle("is-selected", this.selectedFiles.length > 0);
		this.imageButtonEl.disabled = disabled;
		this.imageInputEl.disabled = disabled;
		this.convertButtonEl.disabled = disabled || this.selectedFiles.length === 0 || selectionError !== null;
		this.convertButtonLabelEl.textContent = disabled ? "Transcribing…" : "Convert to Markdown";
		setIcon(this.convertButtonIconEl, disabled ? "loader-2" : "wand");
	}

	private setStatus(message: string, tone: "neutral" | "loading" | "error" | "success"): void {
		this.statusEl.empty();
		this.statusEl.dataset.tone = tone;
		this.statusEl.classList.toggle("is-hidden", message.length === 0);
		if (!message) {
			return;
		}

		const statusIconEl = this.statusEl.createDiv({ cls: "hto-status-icon" });
		setIcon(
			statusIconEl,
			tone === "loading" ? "loader-2" : tone === "error" ? "alert-circle" : tone === "success" ? "check-circle-2" : "info",
		);
		this.statusEl.createDiv({
			cls: "hto-status-message",
			text: message,
		});
	}

	private updateSelectedFileState(): void {
		if (this.selectedFiles.length === 0) {
			this.selectedSectionEl.classList.add("is-hidden");
			this.selectedFileCardEl.removeClass("is-error");
			this.selectedFileNameEl.textContent = "";
			this.selectedFileMetaEl.textContent = "";
			setIcon(this.selectedFileIconEl, "file");
			return;
		}

		this.selectedSectionEl.classList.remove("is-hidden");
		this.selectedFileCardEl.removeClass("is-error");
		const selectionError = getUploadSelectionError(this.selectedFiles);
		if (selectionError) {
			this.selectedFileCardEl.addClass("is-error");
			this.selectedFileNameEl.textContent = "Unsupported selection";
			this.selectedFileMetaEl.textContent = selectionError;
			setIcon(this.selectedFileIconEl, "alert-circle");
			return;
		}

		const totalBytes = this.selectedFiles.reduce((sum, file) => sum + file.size, 0);
		const firstFile = this.selectedFiles[0];
		if (isPdfUpload(firstFile)) {
			setIcon(this.selectedFileIconEl, "file-text");
			this.selectedFileNameEl.textContent = firstFile.name;
			this.selectedFileMetaEl.textContent = `PDF · ${formatFileSize(totalBytes)}`;
			return;
		}

		const imageLabel = this.selectedFiles.length === 1
			? firstFile.name
			: `${this.selectedFiles.length} images selected`;
		setIcon(this.selectedFileIconEl, this.selectedFiles.length > 1 ? "images" : "image");
		this.selectedFileNameEl.textContent = imageLabel;
		this.selectedFileMetaEl.textContent = this.selectedFiles.length === 1
			? formatFileSize(totalBytes)
			: `${firstFile.name} + ${this.selectedFiles.length - 1} more · ${formatFileSize(totalBytes)}`;
	}
}

function stripExtension(fileName: string): string {
	return fileName.replace(/\.[^/.]+$/, "");
}

function createSourceCard(
	containerEl: HTMLElement,
	options: {
		description: string;
		icon: string;
		modifierClass?: string;
		title: string;
	},
): HTMLButtonElement {
	const cardEl = containerEl.createEl("button", {
		attr: { type: "button" },
		cls: `hto-source-card${options.modifierClass ? ` ${options.modifierClass}` : ""}`,
	});
	const iconEl = cardEl.createDiv({ cls: "hto-source-card-icon" });
	setIcon(iconEl, options.icon);
	const bodyEl = cardEl.createDiv({ cls: "hto-source-card-body" });
	bodyEl.createDiv({ cls: "hto-source-card-title", text: options.title });
	bodyEl.createDiv({ cls: "hto-source-card-description", text: options.description });
	return cardEl;
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}

	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}

	return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function looksLikeSecretReference(value: string): boolean {
	return value.length > 0
		&& !detectProviderFromApiKey(value)
		&& /^[a-z0-9][a-z0-9-_]*$/i.test(value);
}

function getUploadSelectionError(files: File[]): string | null {
	if (files.length === 0) {
		return null;
	}

	const pdfCount = files.filter((file) => isPdfUpload(file)).length;
	const imageCount = files.filter((file) => isImageUpload(file)).length;

	if (pdfCount + imageCount !== files.length) {
		return "Unsupported file type. Choose one PDF or one or more images.";
	}

	if (pdfCount > 0 && imageCount > 0) {
		return "Choose either one PDF or one or more images, not both together.";
	}

	if (pdfCount > 1) {
		return "Choose a single PDF or one or more images.";
	}

	return null;
}

function isPdfUpload(file: File): boolean {
	const lowerName = file.name.toLowerCase();
	const lowerType = file.type.toLowerCase();
	return lowerType === "application/pdf" || lowerName.endsWith(".pdf");
}

function isImageUpload(file: File): boolean {
	const lowerName = file.name.toLowerCase();
	const lowerType = file.type.toLowerCase();
	return lowerType.startsWith("image/")
		|| [".bmp", ".gif", ".heic", ".heif", ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"]
			.some((extension) => lowerName.endsWith(extension));
}

function isCameraPluginCommand(command: { id: string; name?: string }): boolean {
	const normalizedId = command.id.toLowerCase();
	const normalizedName = (command.name ?? "").toLowerCase();

	if (normalizedId === CAMERA_PLUGIN_COMMAND_ID.toLowerCase()) {
		return true;
	}

	if (normalizedId === CAMERA_PLUGIN_ID) {
		return true;
	}

	if (normalizedId.startsWith(`${CAMERA_PLUGIN_ID}:`)) {
		return true;
	}

	return normalizedId.includes("camera") && normalizedName.includes("camera");
}

function getCameraCommandScore(command: { id: string; name?: string }): number {
	const normalizedId = command.id.toLowerCase();
	const normalizedName = (command.name ?? "").toLowerCase();
	let score = 0;

	if (normalizedId === CAMERA_PLUGIN_ID) {
		score += 120;
	}
	if (normalizedId.startsWith(`${CAMERA_PLUGIN_ID}:`)) {
		score += 100;
	}
	if (normalizedName.includes("take photo") || normalizedName.includes("take picture")) {
		score += 80;
	}
	if (normalizedId.includes("photo") || normalizedId.includes("picture") || normalizedId.includes("image")) {
		score += 60;
	}
	if (normalizedName.includes("capture") || normalizedName.includes("take")) {
		score += 40;
	}
	if (normalizedName.includes("video") || normalizedId.includes("video") || normalizedId.includes("record")) {
		score -= 80;
	}
	if (normalizedName.includes("camera") || normalizedId.includes("camera")) {
		score += 20;
	}

	return score;
}

function isSupportedCapturedImage(file: TFile): boolean {
	return Boolean(getMimeTypeFromExtension(file.extension));
}

function isInsideCameraCaptureFolder(file: TFile, captureFolder: string): boolean {
	const normalizedFolder = normalizePath(captureFolder);
	if (!normalizedFolder) {
		return false;
	}

	const filePath = normalizePath(file.path);
	return filePath === normalizedFolder || filePath.startsWith(`${normalizedFolder}/`);
}

function getMimeTypeFromExtension(extension: string): string {
	const normalizedExtension = extension.toLowerCase();
	switch (normalizedExtension) {
		case "bmp":
			return "image/bmp";
		case "gif":
			return "image/gif";
		case "heic":
			return "image/heic";
		case "heif":
			return "image/heif";
		case "jpeg":
		case "jpg":
			return "image/jpeg";
		case "png":
			return "image/png";
		case "tif":
		case "tiff":
			return "image/tiff";
		case "webp":
			return "image/webp";
		default:
			return "";
	}
}
