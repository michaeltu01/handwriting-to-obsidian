import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import type HandwritingToObsidianPlugin from "./plugin";
import { TemplatePickerModal } from "./template-modal";

export function openConfiguredTemplatePicker(
	app: App,
	plugin: HandwritingToObsidianPlugin,
	onSelect: (template: TFile) => void,
	onCancel: () => void,
): void {
	const folderSetting = plugin.settings.templateFolder.trim();
	if (!folderSetting) {
		new Notice("Set a template folder in the plugin settings first.");
		return;
	}

	const normalizedFolder = normalizePath(folderSetting);
	const folder = app.vault.getAbstractFileByPath(normalizedFolder);
	if (!folder || !(folder instanceof TFolder)) {
		new Notice("Template folder not found. Check the path in plugin settings.");
		return;
	}

	new TemplatePickerModal(app, normalizedFolder, onSelect, onCancel).open();
}
