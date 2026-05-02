# handwriting-to-obsidian

## Current scope

- Import a handwritten `image/*` file or `PDF` from inside Obsidian.
- Transcribe it into structured Markdown through the configured provider API.
- Create a new note in a configurable vault folder.
- Store the API key in Obsidian Secret Storage.
- Run on both desktop and mobile Obsidian.
- On mobile, optionally open `obsidian-camera` directly and import the next captured image automatically.

## Architecture

The plugin uses Obsidian's `requestUrl` API to send image and PDF inputs directly to `OpenAI` or `Anthropic`. That keeps the import flow working across both desktop and mobile Obsidian without any native runtime dependency.

## Setup

1. Create or open an Obsidian test vault.
2. Clone this repository into `<vault>/.obsidian/plugins/handwriting-to-obsidian`.
3. Run `pnpm install`.
4. Run `pnpm build` once, or `pnpm watch` while developing.
5. Use Obsidian `1.11.4` or newer.
6. In Obsidian, enable the plugin in Community Plugins.
7. Open the plugin settings and configure:
   - API key secret: select an Obsidian Secret Storage entry whose value is your raw `OpenAI` or `Anthropic` API key
   - Output folder for generated Markdown notes

## Usage

1. Click the ribbon icon or run `Import handwritten note` from the command palette.
2. Choose either an image/photo or a PDF.
3. Wait for the transcription to finish.
4. The plugin creates a Markdown note in the configured folder and can open it automatically.

### Mobile camera flow

Run the plugin command "Capture handwritten note by camera" to capture handwritten notes using your phone's native camera application. You can capture multiple pages, one page at a time, and upload them all to be transcribed into one Obsidian note. Tested on iOS.
