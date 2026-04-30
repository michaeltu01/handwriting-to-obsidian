import { App, Modal, Notice, Platform, setIcon } from "obsidian";
import type HandwritingToObsidianPlugin from "./plugin";
import { getUploadSelectionError, isPdfUpload } from "./upload";
import { NativeCameraModal } from "./native-camera";

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
			text: "Choose a PDF or note images to convert into Markdown",
		});

		const sourceSectionEl = shell.createDiv({ cls: "hto-section" });
		const sourceGridEl = sourceSectionEl.createDiv({ cls: "hto-source-grid" });

		if (Platform.isMobileApp) {
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
		
		this.close();
		new NativeCameraModal(this.app, this.plugin).open();
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
