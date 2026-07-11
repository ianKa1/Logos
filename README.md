# card_GDD

Collaborative game design doc pipeline: collaborators write freeform notes on a Notion **Draft** page; a script periodically has Claude restructure them into a clean **GDD** page, keeping snapshots in `docs/` for version history.

```
Notion Draft ──▶ sync script ──▶ Claude (restructure) ──▶ Notion GDD
                                                      └──▶ docs/gdd.md (committed)
```

## Setup

### 1. Notion

1. Create an internal integration at https://www.notion.so/my-integrations with read/update/insert content capabilities. Copy the secret.
2. Create a parent page (e.g. `Card GDD`) with two subpages: **Draft** and **GDD**. Paste your current notes into Draft.
3. On the parent page: `⋯` → **Connections** → add your integration.
4. Grab both page IDs (the 32 hex chars at the end of each page URL).

### 2. Local

```bash
npm install
cp .env.example .env   # fill in NOTION_TOKEN and the two page IDs
```

Claude Code must be installed and logged in (it already is if you use it daily).

### 3. GitHub (for scheduled runs)

1. Push this repo to GitHub.
2. Run `claude setup-token` locally to generate a long-lived OAuth token.
3. Add repository secrets (Settings → Secrets and variables → Actions):
   - `NOTION_TOKEN`
   - `NOTION_DRAFT_PAGE_ID`
   - `NOTION_GDD_PAGE_ID`
   - `NOTION_PRINCIPLES_PAGE_ID` (optional — design pillars page)
   - `CLAUDE_CODE_OAUTH_TOKEN`

The workflow (`.github/workflows/gdd-sync.yml`) runs daily at 03:00 UTC and can be triggered manually from the Actions tab (with an optional "force" flag). Edit the `cron` line to change the cadence.

## Usage

```bash
npm run sync          # restructure if the draft changed since last run
npm run sync:force    # restructure unconditionally
```

Each run:
1. Pulls the Draft page **and all its subpages** → markdown (subpages become labeled sections), plus the **First Principles** page if configured
2. Checks the GDD page for manual edits since the last sync (treated as designer input, not overwritten)
3. Skips if draft, GDD, and principles are all unchanged since last snapshot (unless forced)
4. Sends first principles + draft + previous GDD + manual edits to Claude with `prompts/restructure.md`
5. Writes `docs/gdd.md` + `docs/draft-snapshot.md`
6. Replaces the Notion GDD page content and snapshots it for the next manual-edit check

## How designers should use the Draft

Paste this legend at the top of the Notion Draft page (as a callout):

> **📝 草稿写作约定**
> - 随便写！结构不限，也可以建子页面（按主题、或按不同玩法方案）。
> - `【决定】xxx` —— 已定案。GDD 会将其作为最终设计，不再标记"待定"。
> - `【弃案】xxx` —— 废弃某想法。GDD 会将其移除（仅此方式可移除内容）。
> - `【问题】xxx` —— 抛出待讨论的问题，会进入 GDD 的"开放问题"。
> - 多个竞争的玩法方案请分别写在"方案A-名称"这样的子页面里，GDD 会并列对比，**不会混合**。
> - 注意：直接**删除**草稿文字并不会从 GDD 移除对应内容（防止误删），要移除请写【弃案】。
> - GDD 页面是机器生成的，但如果你直接改了它，改动会被保留并整合，不会被覆盖。

Key behaviors:
- **Subpages**: the whole Draft page tree is read (up to 3 levels deep). Organize however you like.
- **Competing variants** (`方案A` / `方案B` subpages) are kept as clearly-labeled alternatives with a comparison table in the GDD until one is marked `【决定】`; the others then move to a "已弃方案" appendix.
- **Manual GDD edits** are detected via a read-back snapshot (`docs/gdd-notion-snapshot.md`), archived to `docs/gdd-manual-edits.md`, and fed to Claude as authoritative designer input on the next run.
- **First Principles** (`NOTION_PRINCIPLES_PAGE_ID`): a separate, rarely-changing page of design pillars. The GDD gets a condensed 设计支柱 section, and draft content that conflicts with a pillar is flagged in Open Questions instead of being silently resolved.

## Tuning the output

Edit `prompts/restructure.md` to change the GDD structure, language, or level of detail. The prompt instructs Claude to keep section structure stable across runs and to collect undecided values into "Tunable Parameters" and "Open Questions" sections.
