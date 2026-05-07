import { App, Modal, Notice, Setting, TFile, setIcon } from "obsidian";
import HandwritingToObsidianPlugin from "./plugin";
import { openConfiguredTemplatePicker } from "./template-picker";

export class NativeCameraModal extends Modal {
	private plugin: HandwritingToObsidianPlugin;
	private capturedFiles: File[] = [];
	private selectedTemplateFile: TFile | null = null;

	constructor(app: App, plugin: HandwritingToObsidianPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		this.contentEl.addClass("hto-import-modal");
		this.render();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.removeClass("hto-import-modal");
		contentEl.empty();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Take photos natively" });

		if (this.capturedFiles.length > 0) {
			contentEl.createEl("p", { text: `${this.capturedFiles.length} photo(s) captured.` });
			const list = contentEl.createEl("ul");
			this.capturedFiles.forEach((f, i) => {
				list.createEl("li", { text: `Image ${i + 1}: ${f.name}` });
			});
		} else {
			contentEl.createEl("p", { text: "No photos captured yet." });
		}

		new Setting(contentEl)
			.setName("Add photos")
			.setDesc("Take or select photos from your device")
			.addButton((btn) =>
				btn
					.setButtonText("Take photo")
					.setCta()
					.onClick(async () => {
						const files = await captureNativeCameraImages(this.app);
						if (files.length > 0) {
							this.capturedFiles.push(...files);
							this.render();
						}
					})
			);

		const templateSectionEl = contentEl.createDiv({ cls: "hto-section" });
		const templateButtonEl = createActionRow(templateSectionEl, {
			buttonText: "Choose",
			description: "Optional Markdown template to format the transcription.",
			icon: "file-text",
			title: "Choose template",
		});
		templateButtonEl.classList.toggle("is-selected", Boolean(this.selectedTemplateFile));
		templateButtonEl.addEventListener("click", () => this.openTemplatePicker());

		const templateSelectedSectionEl = templateSectionEl.createDiv({
			cls: `hto-selected-section${this.selectedTemplateFile ? "" : " is-hidden"}`,
		});
		const templateSelectedCardEl = templateSelectedSectionEl.createDiv({
			cls: "hto-selected-file-card",
		});
		const templateSelectedIconEl = templateSelectedCardEl.createDiv({
			cls: "hto-selected-file-icon",
		});
		setIcon(templateSelectedIconEl, "file-text");
		const templateSelectedBodyEl = templateSelectedCardEl.createDiv({
			cls: "hto-selected-file-body",
		});
		const templateSelectedNameEl = templateSelectedBodyEl.createDiv({
			cls: "hto-selected-file-name",
			text: this.selectedTemplateFile?.basename ?? "",
		});
		const templateSelectedMetaEl = templateSelectedBodyEl.createDiv({
			cls: "hto-selected-file-meta",
			text: this.selectedTemplateFile?.path ?? "",
		});
		const templateClearButtonEl = templateSelectedSectionEl.createEl("button", {
			attr: { type: "button" },
			cls: "hto-secondary-button hto-template-clear-button",
			text: "Clear template",
		});
		templateClearButtonEl.disabled = !this.selectedTemplateFile;
		templateClearButtonEl.addEventListener("click", () => this.clearTemplateSelection());

		const buttonContainer = contentEl.createDiv("modal-button-container");
		buttonContainer.style.display = "flex";
		buttonContainer.style.justifyContent = "flex-end";
		buttonContainer.style.gap = "10px";
		buttonContainer.style.marginTop = "20px";

		const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
		cancelBtn.onclick = () => {
			this.capturedFiles = [];
			this.close();
		};

		const uploadBtn = buttonContainer.createEl("button", { text: "Upload" });
		uploadBtn.className = "mod-cta";
		uploadBtn.disabled = this.capturedFiles.length === 0;
		uploadBtn.onclick = async () => {
			if (this.capturedFiles.length === 0) return;
			const filesToUpload = [...this.capturedFiles];
			this.close();
			
			new Notice(`Transcribing ${filesToUpload.length} native image(s)...`);
			await saveImagesToAttachments(this.app, filesToUpload);
			await this.plugin.importHandwrittenFiles(filesToUpload, this.selectedTemplateFile ?? undefined);
		};
	}

	private openTemplatePicker(): void {
		openConfiguredTemplatePicker(
			this.app,
			this.plugin,
			(template) => {
				this.selectedTemplateFile = template;
				this.render();
			},
			() => {
				this.render();
			},
		);
	}

	private clearTemplateSelection(): void {
		this.selectedTemplateFile = null;
		this.render();
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

export async function captureNativeCameraImages(app: App): Promise<File[]> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "image/*";
		input.multiple = true;
		input.capture = "environment";
		input.style.display = "none";

		// Handle when files are selected
		input.onchange = async () => {
			if (!input.files || input.files.length === 0) {
				resolve([]);
				input.remove();
				return;
			}
			
			const files = Array.from(input.files);
			resolve(files);
			input.remove();
		};

		// Clean up nicely if they cancel
		input.oncancel = () => {
			resolve([]);
			input.remove();
		};

		// Fallback for iOS: if the user cancels and oncancel doesn't fire, 
		// the window regains focus. Give it a short delay to allow onchange to fire first.
		const onFocus = () => {
			setTimeout(() => {
				resolve([]);
				if (input.parentNode) {
					input.remove();
				}
				window.removeEventListener("focus", onFocus);
			}, 1000);
		};
		window.addEventListener("focus", onFocus);

		document.body.appendChild(input);
		input.click();
		// Do not remove the input synchronously, it will break iOS file picker!
	});
}

export async function saveImagesToAttachments(app: App, files: File[]): Promise<TFile[]> {
	const savedFiles: TFile[] = [];
	
	for (const file of files) {
		const extension = file.name.split('.').pop() || "jpg";
		const basePath = await app.fileManager.getAvailablePathForAttachment(`captured-image.${extension}`);
		
		const buffer = await file.arrayBuffer();
		const tfile = await app.vault.createBinary(basePath, buffer);
		savedFiles.push(tfile);
	}
	
	return savedFiles;
}
