import { App, Notice, TFile } from "obsidian";

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
				return;
			}
			
			const files = Array.from(input.files);
			resolve(files);
		};

		// Clean up nicely if they cancel
		input.oncancel = () => {
			resolve([]);
		};

		document.body.appendChild(input);
		input.click();
		document.body.removeChild(input);
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
