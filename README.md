# handwriting-to-obsidian

Week 1 vertical slice for the CS 1377 final project: upload a handwritten image/photo or PDF, send it to an LLM, and create a Markdown note inside Obsidian.

## Current scope

- Import a handwritten `image/*` file or `PDF` from inside Obsidian.
- Transcribe it into structured Markdown through the configured provider API.
- Create a new note in a configurable vault folder.
- Store the API key in Obsidian Secret Storage.
- Run on both desktop and mobile Obsidian.
- On mobile, optionally open `obsidian-camera` directly and import the next captured image automatically.

## Mobile support

The plugin originally used `@boundaryml/baml` directly at runtime, but that package loads native `.node` binaries and Node-only modules such as `node:fs` and `node:module`. That works on desktop Node environments and breaks on Obsidian mobile.

The live transcription path now avoids that runtime dependency. Instead, the plugin uses Obsidian's `requestUrl` API to send image and PDF inputs directly to the selected provider (`OpenAI` or `Anthropic`), which keeps the same import flow working across desktop and mobile.

## Setup

1. Create or open an Obsidian test vault.
2. Clone this repository into `<vault>/.obsidian/plugins/handwriting-to-obsidian`.
3. Run `pnpm install`.
4. Run `pnpm build` once, or `pnpm watch` while developing.
5. Use Obsidian `1.11.4` or newer.
6. In Obsidian, enable the plugin in Community Plugins.
7. Open the plugin settings and configure:
   - Provider: `OpenAI` or `Anthropic`
   - API key: stored in Secret Storage
   - Output folder for generated Markdown notes

## Usage

1. Click the ribbon icon or run `Import handwritten note` from the command palette.
2. Choose either an image/photo or a PDF.
3. Wait for the transcription to finish.
4. The plugin creates a Markdown note in the configured folder and can open it automatically.

### Mobile camera flow

If the `obsidian-camera` community plugin is installed and enabled, the import modal on mobile shows a `Take photo with Camera plugin` button. That opens the camera plugin, waits for the next image it saves into the vault, and then runs the handwritten-note import pipeline on that captured photo.
