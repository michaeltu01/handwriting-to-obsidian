import { App, type EventRef, Notice, TAbstractFile, TFile, normalizePath } from "obsidian";
import { isSupportedCapturedImage } from "./upload";

const CAMERA_PLUGIN_ID = "obsidian-camera";
const CAMERA_PLUGIN_COMMAND_ID = `${CAMERA_PLUGIN_ID}:Open camera modal`;
const CAMERA_CAPTURE_TIMEOUT_MS = 2 * 60 * 1000;
const CAMERA_CAPTURE_IDLE_MS = 6 * 1000;
const DEFAULT_CAMERA_PLUGIN_FOLDER = "attachments/snaps";

type CameraPlugin = { settings?: { chosenFolderPath?: string } };
type CommandRegistry = Record<string, { id: string; name?: string }>;
type CommandManager = {
	commands?: CommandRegistry;
	executeCommandById?: (id: string) => boolean | void;
};

export function hasCameraPluginInstalled(app: App): boolean {
	const plugins = (app as App & { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins;
	return Boolean(plugins?.[CAMERA_PLUGIN_ID]);
}

export function getCameraPluginCaptureFolder(app: App): string {
	const cameraPlugin = (app as App & { plugins?: { plugins?: Record<string, CameraPlugin> } })
		.plugins?.plugins?.[CAMERA_PLUGIN_ID];

	return normalizePath(
		cameraPlugin?.settings?.chosenFolderPath?.trim() || DEFAULT_CAMERA_PLUGIN_FOLDER,
	);
}

export function getCameraPluginCommandId(app: App): string | null {
	const commandRegistry = (app as App & { commands?: CommandManager }).commands?.commands;
	if (!commandRegistry) {
		return null;
	}

	if (commandRegistry[CAMERA_PLUGIN_COMMAND_ID]) {
		return CAMERA_PLUGIN_COMMAND_ID;
	}

	const candidates = Object.values(commandRegistry)
		.filter((command) => isCameraPluginCommand(command))
		.sort((left, right) => getCameraCommandScore(right) - getCameraCommandScore(left));

	return candidates[0]?.id ?? null;
}

export async function captureImagesWithCameraPlugin(
	app: App,
	commandId: string,
	captureFolder: string,
): Promise<TFile[]> {
	const commandManager = (app as App & { commands?: CommandManager }).commands;
	if (!commandManager?.executeCommandById) {
		throw new Error("Obsidian command execution is unavailable.");
	}
	const executeCommandById = commandManager.executeCommandById.bind(commandManager);

	const startedAt = Date.now();
	let timeoutId = 0;
	let idleTimeoutId = 0;
	let completed = false;
	let eventRef: EventRef | null = null;
	const capturedFiles = new Map<string, TFile>();

	return await new Promise<TFile[]>((resolve, reject) => {
		const cleanup = () => {
			if (eventRef) {
				app.vault.offref(eventRef);
			}
			if (timeoutId) {
				window.clearTimeout(timeoutId);
			}
			if (idleTimeoutId) {
				window.clearTimeout(idleTimeoutId);
			}
		};

		const finishCapture = () => {
			if (completed) {
				return;
			}

			completed = true;
			cleanup();
			const orderedFiles = Array.from(capturedFiles.values())
				.sort((left, right) => left.stat.ctime - right.stat.ctime);
			resolve(orderedFiles);
		};

		const scheduleIdleFinish = () => {
			if (idleTimeoutId) {
				window.clearTimeout(idleTimeoutId);
			}

			idleTimeoutId = window.setTimeout(() => {
				if (capturedFiles.size === 0) {
					return;
				}

				finishCapture();
			}, CAMERA_CAPTURE_IDLE_MS);
		};

		eventRef = app.vault.on("create", (abstractFile: TAbstractFile) => {
			if (!(abstractFile instanceof TFile)) {
				return;
			}

			if (!isSupportedCapturedImage(abstractFile)) {
				return;
			}

			if (!isInsideCameraCaptureFolder(abstractFile, captureFolder)) {
				return;
			}

			if (abstractFile.stat.ctime + 1000 < startedAt) {
				return;
			}

			capturedFiles.set(abstractFile.path, abstractFile);
			scheduleIdleFinish();
		});

		timeoutId = window.setTimeout(() => {
			if (completed) {
				return;
			}

			if (capturedFiles.size > 0) {
				finishCapture();
				return;
			}

			cleanup();
			reject(new Error("Timed out waiting for captured images from the Camera plugin."));
		}, CAMERA_CAPTURE_TIMEOUT_MS);

		try {
			const result = executeCommandById(commandId);
			if (result === false) {
				cleanup();
				reject(new Error("Failed to open the Camera plugin command."));
			}
		} catch (error) {
			cleanup();
			reject(error instanceof Error ? error : new Error("Failed to run the Camera plugin command."));
		}
	});
}

export function showCameraCaptureNotice(): void {
	new Notice("Open Obsidian Camera and take one or more photos. Import starts a few seconds after the last image is saved.");
}

function isCameraPluginCommand(command: { id: string; name?: string }): boolean {
	const normalizedId = command.id.toLowerCase();
	const normalizedName = (command.name ?? "").toLowerCase();

	if (normalizedId === CAMERA_PLUGIN_COMMAND_ID.toLowerCase()) {
		return true;
	}

	if (normalizedId === CAMERA_PLUGIN_ID) {
		return true;
	}

	if (normalizedId.startsWith(`${CAMERA_PLUGIN_ID}:`)) {
		return true;
	}

	return normalizedId.includes("camera") && normalizedName.includes("camera");
}

function getCameraCommandScore(command: { id: string; name?: string }): number {
	const normalizedId = command.id.toLowerCase();
	const normalizedName = (command.name ?? "").toLowerCase();
	let score = 0;

	if (normalizedId === CAMERA_PLUGIN_ID) {
		score += 120;
	}
	if (normalizedId.startsWith(`${CAMERA_PLUGIN_ID}:`)) {
		score += 100;
	}
	if (normalizedName.includes("take photo") || normalizedName.includes("take picture")) {
		score += 80;
	}
	if (normalizedId.includes("photo") || normalizedId.includes("picture") || normalizedId.includes("image")) {
		score += 60;
	}
	if (normalizedName.includes("capture") || normalizedName.includes("take")) {
		score += 40;
	}
	if (normalizedName.includes("video") || normalizedId.includes("video") || normalizedId.includes("record")) {
		score -= 80;
	}
	if (normalizedName.includes("camera") || normalizedId.includes("camera")) {
		score += 20;
	}

	return score;
}

function isInsideCameraCaptureFolder(file: TFile, captureFolder: string): boolean {
	const normalizedFolder = normalizePath(captureFolder);
	if (!normalizedFolder) {
		return false;
	}

	const filePath = normalizePath(file.path);
	return filePath === normalizedFolder || filePath.startsWith(`${normalizedFolder}/`);
}
