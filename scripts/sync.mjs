import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@notionhq/client';
import { NotionToMarkdown } from 'notion-to-md';
import { markdownToBlocks } from '@tryfabric/martian';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = path.join(root, 'docs');
const GDD_FILE = path.join(DOCS_DIR, 'gdd.md');
const DRAFT_SNAPSHOT_FILE = path.join(DOCS_DIR, 'draft-snapshot.md');
// Read-back of the GDD page after our last write; used to detect manual edits.
const GDD_NOTION_SNAPSHOT_FILE = path.join(DOCS_DIR, 'gdd-notion-snapshot.md');
const MANUAL_EDITS_FILE = path.join(DOCS_DIR, 'gdd-manual-edits.md');
const PRINCIPLES_SNAPSHOT_FILE = path.join(DOCS_DIR, 'first-principles.md');
const PROMPT_FILE = path.join(root, 'prompts', 'restructure.md');

const MAX_SUBPAGE_DEPTH = 3;

const force = process.argv.includes('--force');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

// Accepts a raw page ID (with or without dashes) or a full Notion URL.
function normalizePageId(input) {
  const matches = input.replace(/-/g, '').match(/[0-9a-f]{32}/gi);
  if (!matches) {
    console.error(`Could not parse a Notion page ID from: ${input}`);
    process.exit(1);
  }
  return matches[matches.length - 1];
}

const notion = new Client({ auth: requireEnv('NOTION_TOKEN') });
const draftPageId = normalizePageId(requireEnv('NOTION_DRAFT_PAGE_ID'));
const gddPageId = normalizePageId(requireEnv('NOTION_GDD_PAGE_ID'));
// Optional: design pillars page; rarely changes.
const principlesPageId = process.env.NOTION_PRINCIPLES_PAGE_ID
  ? normalizePageId(process.env.NOTION_PRINCIPLES_PAGE_ID)
  : null;

// parseChildPages: false — we recurse into child pages ourselves so we can
// label each subpage and control depth.
const n2m = new NotionToMarkdown({
  notionClient: notion,
  config: { parseChildPages: false },
});

async function pageToMd(pageId) {
  const blocks = await n2m.pageToMarkdown(pageId);
  return (n2m.toMarkdownString(blocks).parent ?? '').trim();
}

async function listAllChildren(blockId) {
  const results = [];
  let cursor;
  do {
    const resp = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      start_cursor: cursor,
    });
    results.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return results;
}

// Renders a page and all its child pages into one markdown string.
// Subpages are emitted as labeled sections so the LLM knows their origin.
async function fetchDraftTree(pageId, depth = 0, title = null) {
  const md = await pageToMd(pageId);
  let out =
    depth === 0
      ? md
      : `\n\n---\n\n${'#'.repeat(Math.min(depth + 1, 6))} 【子页面】${title}\n\n${md}`;

  if (depth < MAX_SUBPAGE_DEPTH) {
    for (const block of await listAllChildren(pageId)) {
      if (block.type === 'child_page') {
        out += await fetchDraftTree(block.id, depth + 1, block.child_page.title);
      }
    }
  }
  return out;
}

// Renders the GDD page + its variant subpages into the ===SUBDOC:=== format
// that the LLM produces and consumes.
async function fetchGddCombined(pageId) {
  let out = await pageToMd(pageId);
  for (const block of await listAllChildren(pageId)) {
    if (block.type === 'child_page') {
      out += `\n\n===SUBDOC: ${block.child_page.title}===\n\n` + (await pageToMd(block.id));
    }
  }
  return out.trim();
}

// Splits LLM output into the main doc and variant subdocs.
function splitSubdocs(md) {
  const parts = md.split(/^===SUBDOC:\s*(.+?)\s*===\s*$/m);
  const main = parts[0].trim();
  const subdocs = [];
  for (let i = 1; i < parts.length; i += 2) {
    const title = parts[i].trim();
    const content = (parts[i + 1] ?? '').trim();
    if (title && content) subdocs.push({ title, content });
  }
  return { main, subdocs };
}

async function appendBlocksBatched(blockId, blocks) {
  for (let i = 0; i < blocks.length; i += 100) {
    await notion.blocks.children.append({
      block_id: blockId,
      children: blocks.slice(i, i + 100),
    });
  }
}

// --- 1. Fetch draft (including subpages) from Notion as markdown ---
console.log('Fetching draft page tree from Notion...');
const draftMd = (await fetchDraftTree(draftPageId)).trim();

if (!draftMd) {
  console.error('Draft page (including subpages) is empty; nothing to do.');
  process.exit(1);
}

// --- 1b. Fetch first principles (design pillars) if configured ---
let principlesMd = '(none)';
let principlesChanged = false;
if (principlesPageId) {
  console.log('Fetching first principles page...');
  principlesMd = (await pageToMd(principlesPageId)) || '(none)';
  const previousPrinciples = existsSync(PRINCIPLES_SNAPSHOT_FILE)
    ? readFileSync(PRINCIPLES_SNAPSHOT_FILE, 'utf8').trim()
    : null;
  principlesChanged = previousPrinciples !== principlesMd;
}

// --- 2. Detect manual edits made directly on the GDD page ---
let manualEdits = '(none)';
const currentGddPageMd = await fetchGddCombined(gddPageId);
if (existsSync(GDD_NOTION_SNAPSHOT_FILE)) {
  const lastWritten = readFileSync(GDD_NOTION_SNAPSHOT_FILE, 'utf8').trim();
  if (lastWritten !== currentGddPageMd) {
    console.warn(
      'Manual edits detected on the GDD page since last sync — they will be treated as designer input.',
    );
    mkdirSync(DOCS_DIR, { recursive: true });
    writeFileSync(MANUAL_EDITS_FILE, currentGddPageMd + '\n');
    manualEdits = currentGddPageMd;
  }
}

// --- 3. Skip if nothing changed (unless --force) ---
if (!force && manualEdits === '(none)' && !principlesChanged && existsSync(DRAFT_SNAPSHOT_FILE)) {
  const previousSnapshot = readFileSync(DRAFT_SNAPSHOT_FILE, 'utf8').trim();
  if (previousSnapshot === draftMd) {
    console.log('Draft, GDD, and principles unchanged since last run; skipping. Use --force to override.');
    process.exit(0);
  }
}

// --- 4. Build the restructure prompt ---
const previousGdd = existsSync(GDD_FILE)
  ? readFileSync(GDD_FILE, 'utf8')
  : '(none — this is the first run)';

const prompt = readFileSync(PROMPT_FILE, 'utf8')
  .replace('{{FIRST_PRINCIPLES}}', principlesMd)
  .replace('{{PREVIOUS_GDD}}', previousGdd)
  .replace('{{MANUAL_EDITS}}', manualEdits)
  .replace('{{DRAFT}}', draftMd);

// --- 5. Run Claude Code headless to produce the updated GDD ---
console.log('Running Claude to restructure the draft into a GDD...');
const result = spawnSync('claude', ['-p', '--output-format', 'text'], {
  input: prompt,
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
});

if (result.error) {
  console.error('Failed to run `claude`. Is Claude Code installed and on PATH?');
  console.error(result.error.message);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`claude exited with status ${result.status}`);
  console.error(result.stderr);
  process.exit(1);
}

let gddMd = result.stdout.trim();
// Unwrap if the model wrapped the whole doc in a code fence despite instructions.
const fenced = gddMd.match(/^```(?:markdown|md)?\n([\s\S]*)\n```$/);
if (fenced) gddMd = fenced[1].trim();

if (!gddMd) {
  console.error('Claude returned empty output; aborting without touching the GDD.');
  process.exit(1);
}

const { main: gddMainMd, subdocs } = splitSubdocs(gddMd);
if (!gddMainMd) {
  console.error('Claude output has no main document; aborting without touching the GDD.');
  process.exit(1);
}

// --- 6. Save local snapshots (committed by CI for version history) ---
mkdirSync(DOCS_DIR, { recursive: true });
writeFileSync(GDD_FILE, gddMd + '\n');
writeFileSync(DRAFT_SNAPSHOT_FILE, draftMd + '\n');
if (principlesPageId) writeFileSync(PRINCIPLES_SNAPSHOT_FILE, principlesMd + '\n');
console.log(`Wrote ${path.relative(root, GDD_FILE)} and ${path.relative(root, DRAFT_SNAPSHOT_FILE)}`);

// --- 7. Replace the content of the GDD page in Notion ---
// Deleting child_page blocks archives last run's variant subpages; they are
// recreated below so the layout stays deterministic (main doc, then subdocs).
console.log('Clearing old GDD page content...');
const oldBlocks = await listAllChildren(gddPageId);
for (const block of oldBlocks) {
  await notion.blocks.delete({ block_id: block.id });
}

console.log('Writing new GDD content to Notion...');
const mainBlocks = markdownToBlocks(gddMainMd);
await appendBlocksBatched(gddPageId, mainBlocks);

for (const { title, content } of subdocs) {
  const blocks = markdownToBlocks(content);
  const page = await notion.pages.create({
    parent: { page_id: gddPageId },
    properties: { title: { title: [{ text: { content: title } }] } },
    children: blocks.slice(0, 100),
  });
  if (blocks.length > 100) await appendBlocksBatched(page.id, blocks.slice(100));
  console.log(`  wrote variant subdoc: ${title}`);
}

// --- 8. Read the page back and snapshot it for manual-edit detection ---
const readBack = await fetchGddCombined(gddPageId);
writeFileSync(GDD_NOTION_SNAPSHOT_FILE, readBack + '\n');

console.log(`Done. GDD updated (${mainBlocks.length} main blocks, ${subdocs.length} variant subdoc(s)).`);
