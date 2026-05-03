/**
 * diagramDebugModal.ts
 *
 * Dev-only modal: pick an image, run resize + diagram detection, render the
 * resized image with detected bounding boxes drawn on top so you can eyeball
 * whether Claude's coordinates are accurate.
 *
 * Wire this up via a command in plugin.ts (see the `addCommand` block).
 * Remove or hide it before shipping.
 */

import { App, Modal, Notice, Setting } from "obsidian";
import { detectDiagrams, type DetectedDiagramBbox } from "./diagramDetection";
import { resizeImageForVision, denormalizeBbox } from "./imageProcessing";

export class DiagramDebugModal extends Modal {
	private apiKey: string;
	private fileInput!: HTMLInputElement;
	private statusEl!: HTMLElement;
	private resultContainer!: HTMLElement;

	constructor(app: App, apiKey: string) {
		super(app);
		this.apiKey = apiKey;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Diagram Detection Debug" });
		contentEl.createEl("p", {
			text: "Pick an image. Plugin will resize it, ask Claude for diagram bounding boxes, and render them on top of the resized image.",
		});

		new Setting(contentEl)
			.setName("Image")
			.setDesc("Choose a single image file.")
			.addButton((btn) => {
				btn.setButtonText("Choose file").onClick(() => this.fileInput.click());
			});

		this.fileInput = contentEl.createEl("input", { type: "file" });
		this.fileInput.accept = "image/*";
		this.fileInput.style.display = "none";
		this.fileInput.addEventListener("change", () => this.handleFile());

		this.statusEl = contentEl.createEl("p");
		this.resultContainer = contentEl.createDiv();
	}

	private async handleFile(): Promise<void> {
		const file = this.fileInput.files?.[0];
		if (!file) return;

		this.resultContainer.empty();
		this.statusEl.setText("Resizing...");

		try {
			const resized = await resizeImageForVision(file, { mimeType: "image/png" });
			this.statusEl.setText(
				`Resized: ${resized.originalWidth}x${resized.originalHeight} -> ${resized.width}x${resized.height}. Calling Claude...`,
			);

			const t0 = performance.now();
			const result = await detectDiagrams(resized.file, this.apiKey);
			const elapsedMs = Math.round(performance.now() - t0);

			this.statusEl.setText(
				`Found ${result.diagrams.length} diagram(s) in ${elapsedMs}ms. (resized: ${resized.width}x${resized.height})`,
			);

			await this.renderOverlay(resized.file, resized.width, resized.height, result.diagrams);
			this.renderJson(result.diagrams);
		} catch (err) {
			console.error(err);
			this.statusEl.setText(`Error: ${err instanceof Error ? err.message : String(err)}`);
			new Notice("Diagram detection failed. See console.");
		}
	}

	private async renderOverlay(
		file: File,
		width: number,
		height: number,
		diagrams: DetectedDiagramBbox[],
	): Promise<void> {
		const wrapper = this.resultContainer.createDiv();
		wrapper.style.position = "relative";
		wrapper.style.display = "inline-block";
		wrapper.style.maxWidth = "100%";
		wrapper.style.border = "1px solid var(--background-modifier-border)";

		const imgUrl = URL.createObjectURL(file);
		const img = wrapper.createEl("img");
		img.src = imgUrl;
		img.style.display = "block";
		img.style.maxWidth = "100%";
		img.style.height = "auto";

		await new Promise<void>((resolve) => {
			img.onload = () => resolve();
		});

		// Render bboxes as positioned divs over the image, using percentages so
		// they scale with the image's responsive width.
		for (const d of diagrams) {
			const px = denormalizeBbox(d.bbox, width, height);
			const left = (px.x / width) * 100;
			const top = (px.y / height) * 100;
			const w = (px.width / width) * 100;
			const h = (px.height / height) * 100;

			const box = wrapper.createDiv();
			box.style.position = "absolute";
			box.style.left = `${left}%`;
			box.style.top = `${top}%`;
			box.style.width = `${w}%`;
			box.style.height = `${h}%`;
			box.style.border = "2px solid #ff3b30";
			box.style.boxSizing = "border-box";
			box.style.pointerEvents = "none";

			const label = wrapper.createDiv();
			label.style.position = "absolute";
			label.style.left = `${left}%`;
			label.style.top = `calc(${top}% - 18px)`;
			label.style.padding = "1px 6px";
			label.style.background = "#ff3b30";
			label.style.color = "white";
			label.style.fontSize = "11px";
			label.style.fontFamily = "var(--font-monospace)";
			label.style.pointerEvents = "none";
			label.setText(`#${d.id} ${d.type}`);
		}
	}

	private renderJson(diagrams: DetectedDiagramBbox[]): void {
		const details = this.resultContainer.createEl("details");
		details.style.marginTop = "1em";
		details.createEl("summary", { text: "Raw bbox JSON" });
		const pre = details.createEl("pre");
		pre.style.fontSize = "11px";
		pre.style.maxHeight = "300px";
		pre.style.overflow = "auto";
		pre.setText(JSON.stringify(diagrams, null, 2));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
