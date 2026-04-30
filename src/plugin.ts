import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import {
	captureImagesWithCameraPlugin,
	getCameraPluginCaptureFolder,
	getCameraPluginCommandId,
	hasCameraPluginInstalled,
	showCameraCaptureNotice,
} from "./camera";
import { HandwrittenImportModal } from "./import-modal";
import {
	buildImportedNoteContent,
	extractMarkdownFromFile,
	extractMarkdownFromImages,
	inferNoteTitle,
	sanitizeFileNameSegment,
} from "./transcription";
import { captureNativeCameraImages, saveImagesToAttachments } from "./native-camera";
import {
	API_KEY_SECRET_ID,
	detectProviderFromApiKey,
	DEFAULT_SETTINGS,
	getApiKeyValidationError as getStoredApiKeyValidationError,
	type HandwritingPluginSettings,
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
			id: "capture-handwritten-note-with-camera",
			name: "Capture handwritten note with Camera plugin",
			mobileOnly: true,
			callback: () => {
				void this.captureWithCameraPluginAndImport();
			},
		});

		this.addCommand({
			id: "take-photo-natively",
			name: "Take photo natively",
			mobileOnly: true,
			callback: async () => {
				const files = await captureNativeCameraImages(this.app);
				if (files.length > 0) {
					new Notice(`Transcribing ${files.length} native image(s)...`);
					// Save them as TFiles first in the attachment folder
					await saveImagesToAttachments(this.app, files);
					// Import them directly
					await this.importHandwrittenFiles(files);
				}
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
		return hasCameraPluginInstalled(this.app);
	}

	async captureWithCameraPluginAndImport(): Promise<TFile> {
		this.refreshApiKeyFromSettings();
		if (!this.apiKey) {
			throw new Error("Select an API key secret in the plugin settings before importing notes.");
		}
		this.getConfiguredProviderOrThrow();

		const commandId = getCameraPluginCommandId(this.app);
		if (!commandId) {
			throw new Error("Could not find an Obsidian Camera command. Install and enable the Camera plugin first.");
		}

		showCameraCaptureNotice();
		const capturedImages = await captureImagesWithCameraPlugin(
			this.app,
			commandId,
			getCameraPluginCaptureFolder(this.app),
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
}

function stripExtension(fileName: string): string {
	return fileName.replace(/\.[^/.]+$/, "");
}

function looksLikeSecretReference(value: string): boolean {
	return value.length > 0
		&& !detectProviderFromApiKey(value)
		&& /^[a-z0-9][a-z0-9-_]*$/i.test(value);
}
