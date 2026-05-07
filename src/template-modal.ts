import { App, FuzzySuggestModal, TFile, normalizePath } from "obsidian";

export class TemplatePickerModal extends FuzzySuggestModal<TFile> {
	private readonly templates: TFile[];
	private readonly onSelect: (template: TFile) => void;
	private readonly onCancel: () => void;
	private resolved = false;
	private readonly folderLabel: string;

	constructor(
		app: App,
		templateFolder: string,
		onSelect: (template: TFile) => void,
		onCancel: () => void,
	) {
		super(app);
		this.onSelect = onSelect;
		this.onCancel = onCancel;

		const normalizedFolder = normalizePath(templateFolder.trim());
		this.folderLabel = normalizedFolder || "templates";
		this.templates = this.buildTemplateList(normalizedFolder);
		this.setPlaceholder("Search templates...");
	}

	getItems(): TFile[] {
		return this.templates;
	}

	getItemText(item: TFile): string {
		return item.path;
	}

	getEmptyStateText(): string {
		if (this.templates.length === 0) {
			return `No templates found in \"${this.folderLabel}\".`;
		}

		return "No matching templates.";
	}

	onChooseItem(item: TFile): void {
		this.resolved = true;
		this.onSelect(item);
	}

	onClose(): void {
		if (!this.resolved) {
			this.onCancel();
		}
		super.onClose();
	}

	private buildTemplateList(folderPath: string): TFile[] {
		if (!folderPath) {
			return [];
		}

		const prefix = folderPath.endsWith("/") ? folderPath : `${folderPath}/`;
		return this.app.vault
			.getMarkdownFiles()
			.filter((file) => file.path.startsWith(prefix))
			.sort((a, b) => a.path.localeCompare(b.path));
	}
}
