/**
 * link-confirmation-modal.ts
 *
 * Modal that displays proposed auto-links as checkbox rows and lets the user
 * confirm which links to apply before the note is created.
 */

import { App, Modal } from "obsidian";
import type { ProposedLink } from "./auto-linking.js";

export class LinkConfirmationModal extends Modal {
	private readonly proposedLinks: ProposedLink[];
	private readonly onConfirm: (confirmedLinks: ProposedLink[]) => void;
	private readonly onSkip: () => void;
	private readonly checkedState: boolean[];
	private resolved = false;

	constructor(
		app: App,
		proposedLinks: ProposedLink[],
		onConfirm: (confirmedLinks: ProposedLink[]) => void,
		onSkip: () => void,
	) {
		super(app);
		this.proposedLinks = proposedLinks;
		this.onConfirm = onConfirm;
		this.onSkip = onSkip;
		this.checkedState = proposedLinks.map(() => true);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("hto-link-modal");

		contentEl.createEl("h2", {
			cls: "hto-title",
			text: "Would you like to create links to your other notes?",
		});

		contentEl.createEl("p", {
			cls: "hto-description",
			text: `Found ${this.proposedLinks.length} reference${this.proposedLinks.length === 1 ? "" : "s"} to existing notes.`,
		});

		const listEl = contentEl.createDiv({ cls: "hto-link-list" });

		for (let i = 0; i < this.proposedLinks.length; i++) {
			const link = this.proposedLinks[i];
			this.renderLinkRow(listEl, link, i);
		}

		const footerEl = contentEl.createDiv({ cls: "hto-link-footer" });

		const skipBtn = footerEl.createEl("button", {
			attr: { type: "button" },
			cls: "hto-link-skip-button",
			text: "Skip linking",
		});
		skipBtn.addEventListener("click", () => {
			this.resolve([]);
		});

		const confirmBtn = footerEl.createEl("button", {
			attr: { type: "button" },
			cls: "mod-cta hto-link-confirm-button",
			text: "Create note with links",
		});
		confirmBtn.addEventListener("click", () => {
			const confirmed = this.proposedLinks.filter((_, i) => this.checkedState[i]);
			this.resolve(confirmed);
		});
	}

	onClose(): void {
		// Escape or click-outside → skip linking (note still created).
		if (!this.resolved) {
			this.resolved = true;
			this.onSkip();
		}
		this.contentEl.removeClass("hto-link-modal");
		this.contentEl.empty();
	}

	private renderLinkRow(containerEl: HTMLElement, link: ProposedLink, index: number): void {
		const rowEl = containerEl.createEl("label", { cls: "hto-link-row" });

		const checkboxEl = rowEl.createEl("input", { type: "checkbox" });
		checkboxEl.checked = true;
		checkboxEl.addEventListener("change", () => {
			this.checkedState[index] = checkboxEl.checked;
		});

		const bodyEl = rowEl.createDiv({ cls: "hto-link-row-body" });

		// Context excerpt with the matched span highlighted.
		const excerptEl = bodyEl.createDiv({ cls: "hto-link-excerpt" });
		const excerptText = link.contextExcerpt;
		const spanIndex = excerptText.indexOf(link.spanText);
		if (spanIndex !== -1) {
			if (spanIndex > 0) {
				excerptEl.appendText(excerptText.slice(0, spanIndex));
			}
			excerptEl.createEl("strong", { text: link.spanText });
			const afterSpan = spanIndex + link.spanText.length;
			if (afterSpan < excerptText.length) {
				excerptEl.appendText(excerptText.slice(afterSpan));
			}
		} else {
			excerptEl.appendText(excerptText);
		}

		// Target note indicator.
		bodyEl.createDiv({
			cls: "hto-link-target",
			text: `→ ${link.targetNote}`,
		});
	}

	private resolve(links: ProposedLink[]): void {
		if (this.resolved) return;
		this.resolved = true;
		this.close();
		if (links.length > 0) {
			this.onConfirm(links);
		} else {
			this.onSkip();
		}
	}
}
