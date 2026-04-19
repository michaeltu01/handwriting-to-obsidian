import {App, PluginSettingTab, SecretComponent, Setting} from "obsidian";
import MyPlugin from "./main";

export interface MyPluginSettings {
	mySetting: string;
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: 'default'
}

export class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('API key')
			.setDesc('Select a secret from SecretStorage')
			.addComponent(el => new SecretComponent(this.app, el)
				.setValue(this.plugin.settings.mySetting)
				.onChange(value => {
				this.plugin.settings.mySetting = value;
				this.plugin.saveSettings();
				}));
	}
}