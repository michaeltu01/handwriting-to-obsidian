import { App, Modal, Notice, Platform, setIcon } from "obsidian";
import type HandwritingToObsidianPlugin from "./plugin";
import { getUploadSelectionError, isPdfUpload } from "./upload";

export class HandwrittenImportModal extends Modal {
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
		contentEl.addClass("hto-import-modal");

		contentEl.createEl("h2", {
			cls: "hto-title",
			text: "Import handwritten note",
		});
		contentEl.createEl("p", {
			cls: "hto-description",
			text: "Choose a PDF or note images to convert into Markdown",
		});

		const sourceSectionEl = contentEl.createDiv({ cls: "hto-section" });

		if (Platform.isMobileApp && this.plugin.hasCameraPluginInstalled()) {
			this.cameraButtonEl = createActionRow(sourceSectionEl, {
				buttonText: "Open",
				description: "Take one or more photos. Import starts after the last saved image.",
				icon: "camera",
				title: "Take photo",
			});
			this.cameraButtonEl.addEventListener("click", () => void this.handleCameraCapture());
		}

		this.imageInputEl = contentEl.createEl("input", { type: "file" });
		this.imageInputEl.accept = "image/*,.pdf,application/pdf";
		this.imageInputEl.multiple = true;
		this.imageInputEl.style.display = "none";

		this.imageButtonEl = createActionRow(sourceSectionEl, {
			buttonText: "Choose",
			description: "Photo, scan, screenshot, gallery images, or a PDF.",
			icon: "files",
			title: "Choose files",
		});

		this.selectedSectionEl = contentEl.createDiv({ cls: "hto-section hto-selected-section is-hidden" });
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

		this.statusEl = contentEl.createDiv({
			cls: "hto-status is-hidden",
		});

		const footerEl = contentEl.createDiv({ cls: "hto-footer" });
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
		this.contentEl.removeClass("hto-import-modal");
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
			this.setStatus(apiKeyValidationError, "error");
			new Notice(apiKeyValidationError);
			return;
		}

		const selectionError = getUploadSelectionError(this.selectedFiles);
		if (selectionError) {
			this.setStatus(selectionError, "error");
			new Notice(selectionError);
			return;
		}

		this.isProcessing = true;
		this.setStatus("", "loading");
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
			this.setStatus(apiKeyValidationError, "error");
			new Notice(apiKeyValidationError);
			return;
		}

		this.isProcessing = true;
		this.setStatus("", "loading");
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
		this.convertButtonLabelEl.textContent = disabled ? "Loading…" : "Convert to Markdown";
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

function createActionRow(
	containerEl: HTMLElement,
	options: {
		buttonText: string;
		description: string;
		icon: string;
		title: string;
	},
): HTMLButtonElement {
	const rowEl = containerEl.createDiv({ cls: "setting-item hto-action-row" });
	const infoEl = rowEl.createDiv({ cls: "setting-item-info" });
	const nameEl = infoEl.createDiv({ cls: "setting-item-name hto-action-name" });
	const iconEl = nameEl.createSpan({ cls: "hto-action-icon" });
	setIcon(iconEl, options.icon);
	nameEl.createSpan({ text: options.title });
	infoEl.createDiv({ cls: "setting-item-description", text: options.description });
	const controlEl = rowEl.createDiv({ cls: "setting-item-control" });
	return controlEl.createEl("button", {
		attr: { type: "button" },
		text: options.buttonText,
	});
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
