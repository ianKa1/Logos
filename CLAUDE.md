# CLAUDE.md

## What this project is

A pipeline that turns a collaborative freeform draft (Notion "Draft" page) into a structured game design document (Notion "GDD" page) using Claude. The game being designed: a 1v1 rock-paper-scissors card game where players author card effects in pseudo-code (see `draft.md` / the Notion Draft page).

## Commands

- `npm run sync` — pull draft from Notion, restructure via `claude -p`, push GDD back to Notion. Skips if draft unchanged.
- `npm run sync:force` — same, but ignores the unchanged check.

Requires `.env` (see `.env.example`) and Claude Code on PATH.

## Architecture

Single pipeline in `scripts/sync.mjs`:

1. Notion Draft page tree → markdown (`notion-to-md`; custom recursion into `child_page` blocks up to depth 3, each subpage emitted as a `【子页面】<title>` section). Also fetches the optional First Principles page (`NOTION_PRINCIPLES_PAGE_ID`, snapshot in `docs/first-principles.md`) — design pillars that the GDD must stay consistent with; conflicts get flagged in Open Questions
2. Manual-edit detection on the GDD: compare the current GDD tree (main page + variant subpages, combined format) vs `docs/gdd-notion-snapshot.md` (read-back from last write). If changed, edits are archived to `docs/gdd-manual-edits.md` and passed to the prompt as designer input
3. Change detection via `docs/draft-snapshot.md` comparison (skips only if draft AND GDD both unchanged)
4. Prompt assembly from `prompts/restructure.md` (placeholders: `{{FIRST_PRINCIPLES}}`, `{{PREVIOUS_GDD}}`, `{{MANUAL_EDITS}}`, `{{DRAFT}}`)
5. `claude -p --output-format text` (headless, prompt via stdin). Output is the main GDD markdown followed by `===SUBDOC: <variant>===`-delimited per-variant documents; `splitSubdocs()` parses them
6. Write `docs/gdd.md` (combined, with SUBDOC markers) + `docs/draft-snapshot.md` (committed by CI for history)
7. Replace Notion GDD content: main page blocks rewritten, old variant subpages archived and recreated (one subpage per SUBDOC — URLs churn each run by design), then the whole tree is read back into `docs/gdd-notion-snapshot.md` in the same combined format

Draft conventions (understood by the prompt): `【决定】` finalizes, `【弃案】` removes (the only removal path — silent deletions don't propagate), `【问题】` → open questions, `方案X` subpages = competing variants kept side-by-side until one is marked `【决定】`.

CI: `.github/workflows/gdd-sync.yml` — daily cron + manual `workflow_dispatch`, commits `docs/` after each run. Secrets: `NOTION_TOKEN`, `NOTION_DRAFT_PAGE_ID`, `NOTION_GDD_PAGE_ID`, `CLAUDE_CODE_OAUTH_TOKEN`.

## Conventions

- The GDD's structure/content rules live in `prompts/restructure.md`, not in code — edit the prompt to change output style.
- The draft is in Chinese; the prompt tells Claude to write the GDD in the draft's language.
- `docs/gdd.md` is machine-written; don't hand-edit it (changes will be overwritten next run). Design changes go in the Notion Draft.
