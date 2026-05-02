import { App, Modal, Notice, Setting, TFile } from "obsidian";
import HandwritingToObsidianPlugin from "./plugin";

export class NativeCameraModal extends Modal {
	private plugin: HandwritingToObsidianPlugin;
	private capturedFiles: File[] = [];

	constructor(app: App, plugin: HandwritingToObsidianPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		this.render();
	}

	onClose() {
		const { contentEl } = this;
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
			await this.plugin.importHandwrittenFiles(filesToUpload);
		};
	}
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
