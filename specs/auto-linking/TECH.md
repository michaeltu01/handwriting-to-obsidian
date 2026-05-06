# Auto-linking — Tech Spec

## Context

See `PRODUCT.md` for all user-facing behavior (invariants 1–26).

### Current import flow

The import entry point is `importHandwrittenFiles` in `src/plugin.ts:121`. The method:

1. Validates API key and file selection
2. Transcribes via `extractMarkdownFromFile` / `extractMarkdownFromImages` (`src/transcription.ts`)
3. Infers a note title
4. Ensures the output folder exists
5. Saves original attachments (if enabled)
6. Processes diagram placeholders (`processDiagramsForImport`)
7. Builds note content via `buildImportedNoteContent`
8. Writes the note to the vault with `app.vault.create`

Auto-linking inserts between steps 6 and 7: after the markdown is finalized but before note content is assembled and written.

Two callers use this method:
- `HandwrittenImportModal` (`src/import-modal.ts:167`) — desktop + mobile file picker flow
- `NativeCameraModal` (`src/native-camera.ts:76`) — mobile camera capture flow

Both `await` the import and handle success/errors. Neither needs changes — the auto-linking step (including the confirmation modal) happens entirely inside `importHandwrittenFiles`.

### Semantic matching strategy

Both OpenAI and Anthropic support tool use with structured output. The approach: send the transcribed markdown plus a summary of each candidate vault note to the configured LLM and ask it to identify semantic references via a `report_links` tool call.

**Why LLM-based matching instead of raw embeddings:**
- Anthropic has no embeddings API; a unified approach avoids asymmetric behavior across providers.
- Embedding-based matching would require a separate model (either an OpenAI-only `text-embedding-3-small` call or a bundled local model like `all-MiniLM-L6-v2` via `@huggingface/transformers`). The local model option adds ~20–90 MB of WASM + model weight downloads and a runtime dependency, violating the project's convention of zero runtime deps. Mobile performance (WASM in Obsidian's mobile webview) is also uncertain.
- LLM tool-use matching is higher quality for this task: the model understands what "references" a note (contextual semantics), not just surface-level similarity. It also returns structured span + target pairs directly, with no threshold tuning.

**Open question:** If users want offline or zero-cost linking in the future, a local WASM embedding model could be added behind a setting. This spec defers that to a follow-up.

## Proposed changes

### New file: `src/auto-linking.ts`

All link-discovery and link-insertion logic lives here. Exports:

```typescript
interface ProposedLink {
  /** Exact text span in the transcription markdown. */
  spanText: string;
  /** Start index of the span in the markdown string. */
  spanStart: number;
  /** Filename (without extension) of the target vault note. */
  targetNote: string;
  /** Full vault path of the target note (for display / disambiguation). */
  targetPath: string;
  /** Short excerpt around the span for display in the confirmation modal. */
  contextExcerpt: string;
}

/** Discover links by sending transcription + note summaries to the LLM. */
async function discoverLinks(args: {
  markdown: string;
  candidateNotes: { basename: string; path: string; summary: string }[];
  apiKey: string;
  provider: HandwritingProvider;
}): Promise<ProposedLink[]>;

/** Apply confirmed links to the markdown, returning modified text. */
function applyLinks(markdown: string, confirmedLinks: ProposedLink[]): string;
```

#### `discoverLinks`

1. Formats a prompt with:
   - The full transcription markdown.
   - A numbered list of candidate notes, each with `basename` and a content summary (title + first ~150 chars of body text, stripped of YAML frontmatter).
2. Calls the LLM via `requestUrl` using tool use (`report_links` tool), following the same dual-provider pattern as `diagramDetection.ts` (`detectWithAnthropic` / `detectWithOpenAI`).
3. Parses the structured response into `ProposedLink[]`.
4. Locates each `spanText` in the markdown to compute `spanStart`. If a span can't be found verbatim, tries a case-insensitive search. Drops any link whose span can't be located.
5. Builds `contextExcerpt` by extracting ~40 chars on each side of the span.

**Tool schema** (shared across providers, same pattern as `REPORT_DIAGRAMS_SCHEMA`):

```json
{
  "name": "report_links",
  "description": "Identify text spans in the transcription that semantically reference an existing vault note.",
  "parameters": {
    "type": "object",
    "properties": {
      "links": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "span_text": {
              "type": "string",
              "description": "The exact text from the transcription that references the note."
            },
            "target_note_index": {
              "type": "integer",
              "description": "The 0-based index of the target note in the candidate list."
            }
          },
          "required": ["span_text", "target_note_index"]
        }
      }
    },
    "required": ["links"]
  }
}
```

Using `target_note_index` rather than the note name avoids issues with the LLM misspelling filenames.

**Prompt guidance** (included in the system/user message alongside the tool):
- Only propose a link when the transcription text genuinely refers to, discusses, or is about the same topic as the candidate note — not just because a common word appears in both.
- Do not link inside markdown syntax (headings markers, link brackets, image embeds, code blocks, YAML frontmatter, `<DIAGRAM_n>` placeholders).
- Prefer longer, more specific spans over single common words.
- Return an empty `links` array if no references are found.

**Context window budget:** Each candidate summary is ~100 tokens. At 500 notes, that's ~50K tokens — well within the 128K context of `gpt-4o-mini` and `claude-sonnet`. For vaults exceeding ~800 notes in scope, truncate to the 800 notes with the shortest vault paths (heuristic: notes closer to the root are more likely to be "topic" notes). Log a console warning when truncation occurs.

**Model selection:** Uses the same models as transcription (`gpt-4o-mini` for OpenAI, `claude-sonnet-4-20250514` for Anthropic). These are sufficient for semantic matching and cheaper than the higher-tier models.

#### `applyLinks`

1. Sorts confirmed links by `spanStart` descending (process back-to-front so earlier replacements don't shift indices).
2. For each link, checks for overlap with already-applied spans. If the current span overlaps a previously applied one, drops it (invariant 16).
3. Replaces the span:
   - If `spanText` equals `targetNote` (case-insensitive): `[[targetNote]]`
   - Otherwise: `[[targetNote|spanText]]`

### New file: `src/link-confirmation-modal.ts`

A modal that displays proposed links as checkbox rows and resolves a Promise with the user's selections.

```typescript
class LinkConfirmationModal extends Modal {
  constructor(
    app: App,
    proposedLinks: ProposedLink[],
    onConfirm: (confirmedLinks: ProposedLink[]) => void,
    onSkip: () => void,
  );
}
```

**Layout:**
- Heading: `"Would you like to create links to your other notes?"`
- For each proposed link: a `<label>` with a checkbox input, the context excerpt (with the span highlighted via `<strong>`), and `→ NoteName` as secondary text.
- Footer with two buttons: "Create note with links" (`mod-cta`) and "Skip linking".
- `onClose` (Escape / click outside) calls `onSkip`.

All DOM is built with Obsidian's `contentEl.createEl` / `createDiv` helpers — no `innerHTML`, no DOM APIs that break on mobile. Checkbox rows use standard `<input type="checkbox">` inside `<label>` elements for accessible touch targets (invariant 23).

**Promise wrapping in plugin.ts:**

```typescript
const confirmedLinks = await new Promise<ProposedLink[]>((resolve) => {
  new LinkConfirmationModal(
    this.app,
    proposedLinks,
    (confirmed) => resolve(confirmed),
    () => resolve([]),
  ).open();
});
```

### Changes to `src/settings.ts`

Add to `HandwritingPluginSettings`:

```typescript
autoLink: boolean;
autoLinkScope: string;
```

Add to `DEFAULT_SETTINGS`:

```typescript
autoLink: true,
autoLinkScope: "",
```

Add two new `Setting` entries in `HandwritingSettingTab.display()`, after the "Open imported note" toggle:

1. **"Auto-link to existing notes"** — toggle, bound to `autoLink`.
2. **"Auto-link scope"** — text input, bound to `autoLinkScope`. Description: `"Limit linking to notes inside this folder (leave empty for entire vault)."` Conditionally shown: only rendered when `autoLink` is `true`. Re-render the settings tab on toggle change.

### Changes to `src/plugin.ts`

Add a private method `runAutoLinking` called from `importHandwrittenFiles` after diagram processing:

```typescript
private async runAutoLinking(
  markdown: string,
  provider: HandwritingProvider,
): Promise<string> {
  // 1. Collect candidate notes
  const scope = this.settings.autoLinkScope.trim();
  let candidates = this.app.vault.getMarkdownFiles();
  if (scope) {
    const normalizedScope = normalizePath(scope);
    candidates = candidates.filter((f) => f.path.startsWith(normalizedScope + "/"));
  }

  if (candidates.length === 0) return markdown;

  // 2. Build summaries (read each note, extract title + excerpt)
  const summaries = await Promise.all(
    candidates.map(async (f) => {
      const content = await this.app.vault.cachedRead(f);
      return {
        basename: f.basename,
        path: f.path,
        summary: buildNoteSummary(f.basename, content),
      };
    }),
  );

  // 3. Discover links via LLM
  const proposedLinks = await discoverLinks({
    markdown,
    candidateNotes: summaries,
    apiKey: this.apiKey,
    provider,
  });

  if (proposedLinks.length === 0) return markdown;

  // 4. Show confirmation modal (resolves when user acts)
  const confirmedLinks = await new Promise<ProposedLink[]>((resolve) => {
    new LinkConfirmationModal(
      this.app,
      proposedLinks,
      (confirmed) => resolve(confirmed),
      () => resolve([]),
    ).open();
  });

  if (confirmedLinks.length === 0) return markdown;

  // 5. Apply links
  return applyLinks(markdown, confirmedLinks);
}
```

The call site in `importHandwrittenFiles`, inserted after the diagram processing block (~line 185) and before `buildImportedNoteContent`:

```typescript
if (this.settings.autoLink) {
  try {
    processedMarkdown = await this.runAutoLinking(processedMarkdown, provider);
  } catch (err) {
    console.warn("Auto-linking failed; note created without links.", err);
    new Notice("Auto-linking failed — note created without links.");
  }
}
```

The try/catch ensures invariants 18–19: linking failures never block the import.

`buildNoteSummary` (in `auto-linking.ts`): strips YAML frontmatter, extracts the first H1 or line as the title, takes the first ~150 characters of body text. Returns a single-line string: `"Title — excerpt..."`.

**`cachedRead` vs `read`:** Uses `app.vault.cachedRead` to avoid re-reading files that Obsidian already has in memory. This is significantly faster for large vaults.

### No esbuild or dependency changes

No new runtime dependencies. No changes to `esbuild.config.mjs` or `package.json`. All new code uses `requestUrl` (from `obsidian`) for HTTP and standard DOM APIs for the modal.

## End-to-end flow

```
User clicks "Convert to Markdown"
  │
  ├─ Transcription (existing) ─── status: "Loading…"
  ├─ Diagram processing (existing)
  ├─ Auto-link discovery (NEW) ── status: "Analyzing links to existing notes…"
  │    ├─ Collect vault .md files in scope
  │    ├─ Build summaries (cachedRead + extract)
  │    └─ LLM tool-use call → ProposedLink[]
  │
  ├─ If links found:
  │    └─ LinkConfirmationModal opens (NEW)
  │         ├─ User checks/unchecks links
  │         ├─ "Create note with links" → applyLinks()
  │         └─ "Skip linking" → no changes
  │
  ├─ buildImportedNoteContent (existing)
  ├─ app.vault.create (existing)
  └─ Open note (if enabled)
```

## Testing and validation

No test framework. Verification plan:

- `pnpm check` — typecheck passes with new files and modified interfaces.
- `pnpm build` — production bundle succeeds, no new externals or missing imports.

**Manual testing matrix** (maps to PRODUCT.md invariants):

- **Settings (1–3):** Toggle on/off in settings; verify scope field appears/hides; verify empty scope → entire vault, set scope → only that folder's notes appear as candidates.
- **Link discovery (4–8):** Import a handwritten note that references a known vault note by a synonym or related phrase. Verify the confirmation modal proposes the correct link. Verify no self-links.
- **Confirmation modal (9–13):** Verify heading text, checkbox default state (checked), uncheck a link and confirm it's excluded, click "Skip linking" and verify no links applied, press Escape and verify note still created.
- **Link insertion (14–16):** Verify `[[Note|span]]` format when span ≠ note name; verify `[[Note]]` when span matches note name; verify overlapping spans are handled (longer wins).
- **Error paths (17–19):** Temporarily break the API key after transcription; verify notice appears and note is created without links.
- **Progress (20–21):** Verify "Analyzing links…" status message appears during discovery.
- **Cross-platform (22–23):** Test on mobile — modal renders, checkboxes are tappable.
- **Feature interaction (24–26):** Import an image with diagrams + text references; verify diagram placeholders are processed before linking and not treated as linkable spans.

## Risks and mitigations

- **Large vaults (800+ notes in scope):** Summaries are truncated to ~800 notes with a console warning. If users report truncation problems, a follow-up could add a pre-computed embedding cache with a local model.
- **LLM hallucinating spans:** `discoverLinks` validates every returned `span_text` against the actual markdown. Spans not found verbatim (after case-insensitive fallback) are silently dropped.
- **LLM returning out-of-range `target_note_index`:** Validated during parsing; out-of-range indices are dropped.
- **Cost:** One additional LLM call per import (same tier as transcription). For `gpt-4o-mini`, this is ~$0.001–0.01 depending on vault size. Acceptable given the feature is opt-in.

## Follow-ups

- **Local embedding model:** Add an optional WASM-based embedding backend (e.g. `all-MiniLM-L6-v2` via `@huggingface/transformers`) for offline / zero-cost linking. Would require a settings toggle, model download UX, and an embedding cache stored in the plugin's data folder.
- **Embedding cache:** If LLM-based discovery proves too slow for large vaults, cache note summaries + embeddings and only re-compute on file changes via `app.vault.on("modify", ...)`.
