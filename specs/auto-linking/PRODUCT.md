# Auto-linking to Existing Vault Notes

## Summary

After transcription, the plugin semantically compares the transcribed text against the user's existing vault notes and proposes wikilinks where the new note appears to reference an existing one. The user reviews proposed links in a confirmation modal before the note is created, choosing which links to keep.

## Problem

Users who maintain an interconnected vault lose value when imported handwritten notes land as orphans. Manually linking a freshly imported note to related existing notes is tedious and easy to forget — especially when the handwritten text refers to a concept by a different name than the vault note's title.

## Behavior

### Settings

1. A new toggle appears in the plugin settings tab: **"Auto-link to existing notes"**. Default: **on**.

2. When the toggle is off, the import flow is unchanged — no linking analysis runs, no confirmation modal appears.

3. A text field **"Auto-link scope"** appears below the toggle (visible only when the toggle is on). It accepts a vault folder path. Default: empty (meaning the entire vault). When set, only markdown notes inside that folder (recursively) are candidates for linking.

### Link discovery

4. When auto-linking is enabled, after transcription completes and before the note file is created, the plugin collects every `.md` file in the configured scope (or entire vault if scope is empty) as link candidates.

5. The plugin uses semantic similarity — not substring or fuzzy matching alone — to identify spans of the transcribed text that appear to refer to an existing vault note. The matching considers the *content and meaning* of both the transcription and the candidate notes, so references phrased differently from the note's title are still caught.

6. Each proposed link is a pair: a span of text in the transcription and a target vault note. A span is a contiguous run of words in the transcription that triggered the match.

7. A note may appear as a target for multiple spans, and a single span may only link to one target. If multiple candidates are equally plausible for the same span, the plugin picks the strongest match.

8. Links are never proposed to the note being created itself.

### Confirmation modal

9. If at least one link is proposed, a modal opens with the heading **"Would you like to create links to your other notes?"**

10. Each proposed link is rendered as a checkbox row. The row shows:
    - The matched text span (in context — a short excerpt of the surrounding sentence).
    - The target note name.
    - The checkbox defaults to **checked**.

11. The modal has two buttons:
    - **"Create note with links"** (primary / `mod-cta`) — applies the checked links and creates the note.
    - **"Skip linking"** — creates the note without any links.

12. Closing the modal (Escape, clicking outside) is equivalent to "Skip linking" — the note is still created, just without links.

13. The user can uncheck individual rows to exclude specific links. Unchecked links are not applied.

### Link insertion

14. For each confirmed link, the matched text span in the transcription markdown is replaced with `[[Target Note|original text]]`. If the matched text is identical (case-insensitive) to the target note's filename (without extension), the simpler `[[Target Note]]` form is used instead.

15. Links are inserted into the raw markdown before frontmatter is prepended and before the note file is written to the vault.

16. If two confirmed links have overlapping spans, the longer span wins and the shorter one is dropped. This prevents malformed nested wikilinks.

### No-match and error paths

17. If zero links are proposed, the confirmation modal is skipped entirely. The import proceeds as if auto-linking were off.

18. If the semantic analysis fails (API error, network timeout, provider rate limit), the plugin shows an Obsidian `Notice`: **"Auto-linking failed — note created without links."** The import continues and the note is created without links.

19. The failure does not block or cancel the import. The user's transcription is never lost due to a linking failure.

### Performance and progress

20. While link discovery is running, the import modal's status indicator shows a loading state with the message **"Analyzing links to existing notes…"**

21. The loading state appears after the transcription status message completes and before the confirmation modal opens.

### Cross-platform

22. The confirmation modal must render correctly on both desktop and mobile, using standard Obsidian `Modal` primitives (no DOM APIs unavailable on mobile).

23. On mobile, checkbox rows should be large enough touch targets (consistent with Obsidian's mobile control sizing).

### Interaction with other features

24. Auto-linking runs after diagram placeholder processing. The markdown passed to link discovery already has `<DIAGRAM_n>` placeholders substituted (or left as-is on failure). Diagram placeholders and image embeds are never treated as linkable text spans.

25. The "Include original document" setting is independent — attachments are saved regardless of whether auto-linking is on.

26. The `llm_provider` frontmatter field reflects the provider used for transcription, not the provider used for link discovery (they are always the same provider today, but this keeps the contract clear).
