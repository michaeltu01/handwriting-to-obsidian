/**
 * settings.ts
 * 
 * This file constructs the settings tab for the Handwriting-to-Obsidian plugin and exports helper functions.
 */

import { App, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type HandwritingToObsidianPlugin from "./main";

export type HandwritingProvider = "openai" | "anthropic";

/**
 * How "Regenerate diagrams in this note" turns a hand-drawn diagram into a
 * machine-rendered version. 'auto' picks Mermaid for structured diagrams
 * (flowcharts, state machines, mind maps) and gpt-image for everything else.
 * 'mermaid' and 'gpt-image' force a single strategy.
 *
 * Only Mermaid is implemented today; 'gpt-image' is reserved for a follow-up
 * PR. Until that lands, both 'auto' (when it would route to gpt-image) and
 * 'gpt-image' fall back to Mermaid with a console warning.
 */
export type DiagramRegenerationMethod = "auto" | "mermaid" | "gpt-image";

export interface HandwritingPluginSettings {
	apiKeySecretId: string;
	includeOriginalDocument: boolean;
	openAfterImport: boolean;
	outputFolder: string;
	diagramRegenerationMethod: DiagramRegenerationMethod;
}

export const API_KEY_SECRET_ID = "handwriting-to-obsidian-api-key";

export const DEFAULT_SETTINGS: HandwritingPluginSettings = {
	apiKeySecretId: "",
	includeOriginalDocument: false,
	openAfterImport: true,
	outputFolder: "Handwritten Notes",
	diagramRegenerationMethod: "mermaid",
};

/**
 * Normalizes the API key input from the user (e.g. removes whitespace, etc.)
 */
export function normalizeApiKeyInput(apiKey: string): string {
	return apiKey
		.trim()
		.replace(/^Bearer\s+/i, "")
		.replace(/^['"`]|['"`]$/g, "")
		.replace(/\u200B/g, "")
		.trim();
}

/**
 * Determines the provider from the API key.
 * 
 * @param apiKey – API key
 * @returns provider value as string or null
 */
export function detectProviderFromApiKey(apiKey: string): HandwritingProvider | null {
	const normalizedKey = normalizeApiKeyInput(apiKey).toLowerCase();
	if (!normalizedKey) {
		return null;
	}

	if (normalizedKey.startsWith("sk-ant-")) {
		return "anthropic";
	}

	if (normalizedKey.startsWith("sk-")) {
		return "openai";
	}

	return null;
}

/**
 * Handles an API key validation error
 * @returns null, if there is no error; otherwise, a string describing the error
 */
export function getApiKeyValidationError(apiKey: string): string | null {
	const normalizedKey = normalizeApiKeyInput(apiKey);
	if (!normalizedKey) {
		return "Select an API key secret in the plugin settings before importing notes.";
	}

	if (detectProviderFromApiKey(normalizedKey)) {
		return null;
	}

	if (normalizedKey.toLowerCase() === "openai-key" || normalizedKey.toLowerCase() === "anthropic-key") {
		return "The selected secret is still a placeholder. Point the plugin at a secret whose value is the real raw OpenAI or Anthropic key.";
	}

	return "The selected secret does not look valid. Its value should be a raw OpenAI `sk-...` key or Anthropic `sk-ant-...` key.";
}

export class HandwritingSettingTab extends PluginSettingTab {
	plugin: HandwritingToObsidianPlugin;

	constructor(app: App, plugin: HandwritingToObsidianPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Handwriting to Obsidian" });

		new Setting(containerEl)
			.setName("API key")
			.setDesc("Select a secret from Obsidian Secret Storage. That secret's value should be the raw Anthropic or OpenAI API key.")
			.addComponent((el) => new SecretComponent(this.app, el)
				.setValue(this.plugin.getApiKeySecretId())
				.onChange((value) => {
					void this.plugin.setApiKeySecretId(value); // NOTE: this function calls saveSettings()
				}));

		new Setting(containerEl)
			.setName("Output folder")
			.setDesc("New Markdown notes will be created here inside the vault.")
			.addText((text) => {
				text
					.setPlaceholder("Handwritten Notes")
					.setValue(this.plugin.settings.outputFolder)
					.onChange(async (value) => {
						this.plugin.settings.outputFolder = value.trim() || DEFAULT_SETTINGS.outputFolder;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Include original document")
			.setDesc(`Include an embed of the original PDF or image(s) at the bottom of the transcribed Markdown note. The original file will be uploaded to the folder the user configures for attachments in the "Files and links" tab`)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.includeOriginalDocument)
					.onChange(async (value) => {
						this.plugin.settings.includeOriginalDocument = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Open imported note")
			.setDesc("Open the generated Markdown note immediately after the transcription finishes.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.openAfterImport)
					.onChange(async (value) => {
						this.plugin.settings.openAfterImport = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Diagram regeneration method")
			.setDesc("How the \"Regenerate diagrams in this note\" command turns a hand-drawn diagram into a machine-rendered version. Auto picks Mermaid for structured diagrams (flowcharts, state machines) and gpt-image for freeform sketches. (gpt-image is not implemented yet and currently falls back to Mermaid.)")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("auto", "Auto (route by diagram type)")
					.addOption("mermaid", "Mermaid only")
					.addOption("gpt-image", "GPT image only (not implemented)")
					.setValue(this.plugin.settings.diagramRegenerationMethod)
					.onChange(async (value) => {
						this.plugin.settings.diagramRegenerationMethod = value as DiagramRegenerationMethod;
						await this.plugin.saveSettings();
					});
			});
	}
}