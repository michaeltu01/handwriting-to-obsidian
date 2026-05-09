# Handwriting to Obsidian

An Obsidian plugin that imports handwritten images or PDFs, transcribes them into structured Markdown using an LLM (OpenAI or Anthropic), and creates a new note in your vault.

Works on both desktop and mobile Obsidian (1.11.4+).

## Features

- **Image & PDF import** — choose one PDF or one or more images. Multi-page images are merged into a single note.
- **LLM transcription** — sends inputs to OpenAI (`gpt-4o-mini`) or Anthropic (`claude-sonnet-4`) via Obsidian's `requestUrl` (no CORS issues, works on mobile).
- **Diagram detection & regeneration** — hand-drawn diagrams are detected, cropped, and embedded in the note as image attachments with `<DIAGRAM_n>` placeholders. Run "Regenerate diagrams in this note" to convert them to Mermaid code blocks or GPT-generated PNGs.
- **Auto-linking** — after transcription, the LLM compares the new note against existing vault notes and proposes `[[wikilinks]]`. A confirmation modal lets you accept or reject each link before the note is created.
- **Templates** — optionally pick a Markdown template to guide the transcription structure (headings, frontmatter fields, sections).
- **Custom instructions** — append freeform instructions to the transcription prompt (e.g. "use `##` for subheadings").
- **Mobile camera** — a mobile-only command opens the native camera so you can photograph multiple pages and import them in one batch.
- **Secure API key storage** — the API key is stored in Obsidian's Secret Storage, never persisted in `data.json`.

## Setup

1. Create or open an Obsidian vault.
2. Clone this repository into `<vault>/.obsidian/plugins/handwriting-to-obsidian`.
3. Run `pnpm install` then `pnpm build` (or `pnpm watch` while developing).
4. In Obsidian, enable the plugin under Community Plugins.
5. Open the plugin settings and configure:
   - **API key** — select an Obsidian Secret Storage entry whose value is your raw OpenAI (`sk-...`) or Anthropic (`sk-ant-...`) API key.
   - **Output folder** — where generated Markdown notes are saved (default: `Handwritten Notes`).

## Usage

### Import a note

1. Click the ribbon icon (pen) or run **Import handwritten note** from the command palette.
2. Choose a PDF or one or more images.
3. Optionally pick a template.
4. Click **Convert to Markdown** and wait for the transcription.
5. The plugin creates a note in the output folder and opens it (if "Open imported note" is enabled).

### Mobile camera flow

Run **Capture handwritten note by camera** from the command palette (mobile only). Take one or more photos, then tap **Upload** to transcribe them into a single note.

### Regenerate diagrams

Open a note that was imported with diagram placeholders and run **Regenerate diagrams in this note** from the command palette. Each hand-drawn diagram crop is sent to the LLM and replaced with a Mermaid code block or a GPT-generated PNG, depending on the configured regeneration method.

## Settings

| Setting | Description |
|---|---|
| API key | Obsidian Secret Storage reference to your OpenAI or Anthropic key |
| Output folder | Vault folder for new notes (default: `Handwritten Notes`) |
| Template folder | Folder containing Markdown templates for guided transcription |
| Custom transcription instructions | Freeform text appended to the LLM prompt |
| Include original document | Embed the source PDF/images at the bottom of the note |
| Open imported note | Automatically open the note after import |
| Auto-link to existing notes | Propose wikilinks to related vault notes after transcription |
| Auto-link scope | Limit auto-linking to a specific vault folder |
| Diagram regeneration method | Auto (route by type), Mermaid only, or GPT image only |

## Commands

- **Import handwritten note** — open the import modal (desktop & mobile).
- **Capture handwritten note by camera** — open the native camera for multi-page capture (mobile only).
- **Regenerate diagrams in this note** — convert diagram crops in the active note to Mermaid or GPT images.
- **Debug: detect diagrams in an image** — visualize diagram bounding boxes for a selected image (development tool).

## Development

Requires `pnpm` (declared in `package.json`).

```bash
pnpm install
pnpm watch    # esbuild in watch mode (writes main.js with sourcemaps)
pnpm build    # production build (no sourcemaps)
pnpm check    # typecheck only (tsc --noEmit)
```

After changes, run `pnpm check` and `pnpm build` to verify the plugin compiles.

For live reloading during development, install the [hot-reload](https://github.com/pjeby/hot-reload) plugin in your vault.
