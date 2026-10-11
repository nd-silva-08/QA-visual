#!/usr/bin/env node
// Render a visual-qa spec into one self-contained HTML report with Before / After / Side-by-side
// views. Code hunks come from git (pr.base → pr.head), never from text copied into the spec.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from './lib/args.mjs';
import { buildHtml, withoutWebFonts } from './lib/build.mjs';
import { findChrome, layoutReport, screenshot } from './lib/chrome.mjs';
import { hunkTouches, parseRange, parseUnifiedDiff } from './lib/diff.mjs';
import { diffText, fileAt, mergeBase, onRemote, remoteUrl, repoRoot, resolveCommit, toWebUrl } from './lib/git.mjs';
import {
  autoLayout, checkCodeRefs, coverage, diagramsOf, diffStats, findOverlaps, forEachItem, matchesUnmapped, missingText,
  resolveCode, summaryMarkdown, validateSpec,
} from './lib/spec.mjs';
import { VERSION } from './lib/version.mjs';

const USAGE = `Usage: node render.mjs <spec.json> [options]

Builds one self-contained HTML report from a visual-qa spec. The diff hunks shown for each
detail.code ref are read from git (pr.base → pr.head), never copied from the spec.

  -o, --out <file>         Output HTML (default: the spec path with .html)
  --repo <dir>             Repository to read diffs from (default: current directory)
  --no-git                 Don't read git; only inline "patch" refs show code
  --summary <file>         Also write a Markdown summary for a PR comment
  --check                  Open the page in headless Chrome and report layout problems
  --screenshot <prefix>    Save <prefix>-<diagram>-before.png / -after.png (implies --check)
  --strict                 Exit 1 on warnings and layout problems, not just errors
  -h, --help               Show this help
`;

const rel = (p) => path.relative(process.cwd(), p) || p;
const short = (s) => String(s).slice(0, 7);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const slug = (s) => String(s).replace(/[^\w.-]+/g, '-');

function die(msg, list) {
  if (list && list.length) {
    console.error(`visual-qa: ${list.length} problem${list.length === 1 ? '' : 's'}:`);
    for (const m of list) console.error(`  ✗ ${m}`);
  }
  console.error(`visual-qa: ${msg}`);
  process.exit(1);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), { boolean: ['help', 'no-git', 'check', 'strict'], alias: { o: 'out', h: 'help' } });
  } catch (e) {
    console.error(e.message);
    console.error(USAGE);
    process.exit(2);
  }
  if (args.help) { console.log(USAGE); return; }
  if (!args._[0]) { console.error(USAGE); process.exit(2); }

  const specPath = path.resolve(args._[0]);
  let spec;
  try {
    spec = JSON.parse(readFileSync(specPath, 'utf8'));
  } catch (e) {
    die(`couldn't read ${rel(specPath)}: ${e.message}`);
  }

  const { errors, warnings } = validateSpec(spec);
  if (errors.length) die('fix the spec and run again. Nothing was written.', errors);
  const notes = [];

  const data = structuredClone(spec);
  data.pr = isObj(data.pr) ? data.pr : {};
  for (const d of diagramsOf(data)) autoLayout(d, warnings);
  const overlaps = [];
  for (const d of diagramsOf(data)) {
    for (const o of findOverlaps(d)) {
      if (o.replacement) continue; // a new node may take a removed node's spot
      overlaps.push(`${diagramsOf(data).length > 1 ? `diagram "${d.id}": ` : ''}nodes "${o.a}" and "${o.b}" overlap in the same row. Move one (col/row) or shrink its span.`);
    }
  }
  if (overlaps.length) die('fix the overlapping nodes. Nothing was written.', overlaps);

  // ---- read the real diff from git
  const pr = data.pr;
  let diffFiles = null;
  let worktree = false;
  let read = null;
  let openLinks = null;
  if (!args['no-git'] && (pr.base || pr.head)) {
    let root;
    try {
      root = repoRoot(path.resolve(args.repo || process.cwd()));
    } catch (_) {
      die('not inside a git repository. Run from the repo, pass --repo <dir>, or use --no-git.');
    }
    const headRef = String(pr.head || 'HEAD');
    worktree = headRef === 'WORKTREE';
    const headSha = resolveCommit(worktree ? 'HEAD' : headRef, root);
    if (!headSha) die(`pr.head "${headRef}" isn't a commit in ${root}. Fetch it first (for a PR: git fetch origin pull/<n>/head).`);
    const baseRef = String(pr.base || '');
    if (!baseRef) die('pr.base is missing. Use the merge-base SHA that collect.mjs prints.');
    const baseSha = resolveCommit(baseRef, root);
    if (!baseSha) die(`pr.base "${baseRef}" isn't a commit in ${root}.`);
    const mb = mergeBase(baseSha, headSha, root) || baseSha;
    if (mb !== baseSha) notes.push(`pr.base ${short(baseSha)} isn't where the branch started; comparing from the merge-base ${short(mb)}, as GitHub does.`);
    diffFiles = parseUnifiedDiff(diffText(mb, worktree ? 'WORKTREE' : headSha, root));
    pr.base = mb;
    pr.head = headSha;
    if (!pr.repoUrl) {
      const web = toWebUrl(remoteUrl(root));
      if (web) pr.repoUrl = web;
    }
    // "Open" links go to the remote at these commits, so they only work once the commits are
    // there. A PR's commits are; for anything else, look at what was last fetched or pushed.
    if (pr.repoUrl) {
      const isPr = pr.number != null && pr.number !== '';
      openLinks = { base: isPr || onRemote(mb, root), head: !worktree && (isPr || onRemote(headSha, root)) };
      const missing = [!openLinks.base && `the before commit ${short(mb)}`, !worktree && !openLinks.head && `the after commit ${short(headSha)}`].filter(Boolean);
      if (missing.length) notes.push(`${missing.join(' and ')} ${missing.length === 1 ? "isn't" : "aren't"} on the remote yet, as far as this clone knows, so the report leaves out "Open" links to ${missing.length === 1 ? 'it' : 'them'}. Push (or fetch, if ${missing.length === 1 ? "it's" : "they're"} there already), then render again to add them.`);
    }
    const byPath = new Map(diffFiles.map((f) => [f.path, f]));
    read = (side, file) => {
      const f = byPath.get(file);
      if (f && f.binary) return null;
      if (side === 'base') return fileAt(mb, (f && f.oldPath) || file, root);
      if (!worktree) return fileAt(headSha, file, root);
      try { return readFileSync(path.join(root, file), 'utf8'); } catch (_) { return null; }
    };
  } else if (!args['no-git']) {
    notes.push('The spec has no pr.base / pr.head, so code is shown only for inline "patch" refs.');
  }

  const { files, referenced, explainedHunks, inlineFiles } = resolveCode(data, diffFiles, warnings);
  if (read) checkCodeRefs(data, read, warnings);
  const cov = coverage(data, diffFiles, referenced, explainedHunks);
  if (cov.unexplained.length) {
    warnings.push(`${cov.unexplained.length} changed file${cov.unexplained.length === 1 ? ' is' : 's are'} not linked from any node or edge and not listed in "unmapped": ${cov.unexplained.map((f) => f.path).join(', ')}`);
  }
  for (const p of cov.partial) {
    warnings.push(`${p.path}: ${p.unexplained} of its ${p.changes} changes ${p.unexplained === 1 ? "isn't" : "aren't"} linked from any node or edge (${missingText(p)}). Point a code ref at them, or set them aside with "unmapped" lines and a reason.`);
  }
  if (diffFiles) {
    for (const u of cov.unmapped) {
      const f = diffFiles.find((x) => matchesUnmapped(x.path, u) || (u.lines && x.oldPath === u.path));
      if (!f) notes.push(`unmapped "${u.path}" doesn't match any changed file.`);
      else if (u.lines && !f.hunks.some((hk) => hunkTouches(hk, parseRange(u.lines), u.side))) {
        notes.push(`unmapped "${u.path}" lines ${u.lines}${u.side === 'base' ? ' (before)' : ''} don't touch any change in that file.`);
      }
    }
  }

  let parts = 0;
  let links = 0;
  const changes = { added: 0, changed: 0, removed: 0 };
  forEachItem(data, (item) => {
    if (item.from !== undefined) links++; else if (item.shape !== 'note') parts++;
    if (changes[item.status] !== undefined) changes[item.status]++;
  });

  data.version = 1;
  data.files = files;
  data.coverage = { unmapped: cov.unmapped, unexplained: cov.unexplained, partial: cov.partial };
  data.stats = diffFiles ? diffStats(diffFiles) : isObj(pr.stats) ? pr.stats : inlineFiles.length ? diffStats(inlineFiles) : null;
  data.generated = {
    tool: 'visual-qa', version: VERSION, at: new Date().toISOString(),
    ...(worktree ? { worktree: true } : {}),
    ...(openLinks ? { links: openLinks } : {}),
  };
  delete data.unmapped;

  const out = path.resolve(args.out || specPath.replace(/\.json$/i, '') + '.html');
  mkdirSync(path.dirname(out), { recursive: true });
  const html = buildHtml(data);
  writeFileSync(out, html);

  if (args.summary) {
    const sp = path.resolve(args.summary);
    mkdirSync(path.dirname(sp), { recursive: true });
    writeFileSync(sp, summaryMarkdown(data, { reportName: path.basename(out) }));
  }

  // ---- optional: render in headless Chrome to catch layout problems and take screenshots
  const layout = [];
  const shots = [];
  let checked = false;
  if (args.check || args.screenshot) {
    const chrome = findChrome();
    if (!chrome) {
      notes.push('Layout check skipped: no Chrome or Chromium found. Set VISUAL_QA_CHROME to its path to enable it.');
    } else {
      // Check a copy without web fonts so the result never depends on the network.
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'visual-qa-'));
      const checkFile = path.join(tmp, 'check.html');
      writeFileSync(checkFile, withoutWebFonts(html));
      try {
        const url = pathToFileURL(checkFile).href;
        const rep = await layoutReport(chrome, url);
        checked = true;
        if (rep.error) layout.push(`the page failed to render: ${rep.error}`);
        const many = (rep.diagrams || []).length > 1;
        for (const d of rep.diagrams || []) {
          const where = many ? `diagram "${d.id}": ` : '';
          for (const c of d.crossings) {
            layout.push(c.area
              ? `${where}edge "${c.edge}" runs through ${c.node}. Move the nodes it connects so it doesn't have to cross there.`
              : `${where}edge "${c.edge}" runs through node "${c.node}". Move a node, or set fromSide/toSide on the edge.`);
          }
          for (const [a, b] of d.overlaps) layout.push(`${where}"${a}" and "${b}" overlap on screen. Give them more room.`);
          for (const l of d.labels) layout.push(`${where}the label on edge "${l.edge}" covers ${l.area ? l.node : `node "${l.node}"`}. Shorten it, split it with \\n, or add room.`);
          for (const u of d.unrouted) layout.push(`${where}edge "${u}" couldn't be drawn.`);
          for (const [a, b] of d.sharedLines) notes.push(`${where}edges "${a}" and "${b}" run along the same line for a stretch; moving a node usually separates them.`);
        }
        if (args.screenshot) {
          const prefix = path.resolve(String(args.screenshot).replace(/\.png$/i, ''));
          mkdirSync(path.dirname(prefix), { recursive: true });
          for (const d of rep.diagrams || []) {
            for (const view of ['before', 'after']) {
              const file = `${prefix}-${slug(d.id)}-${view}.png`;
              if (await screenshot(chrome, url, file, { width: d.width, height: d.height, diagram: d.id, view })) shots.push(file);
            }
          }
        }
      } catch (e) {
        notes.push(`Layout check couldn't run: ${String(e.message).split('\n')[0]}`);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  }

  // ---- report
  const ds = diagramsOf(data);
  const total = changes.added + changes.changed + changes.removed;
  console.log(`visual-qa · wrote ${rel(out)}`);
  console.log(`  ${ds.length} diagram${ds.length === 1 ? '' : 's'} · ${parts} parts · ${links} links · ${total} change${total === 1 ? '' : 's'} (${changes.added} new, ${changes.changed} changed, ${changes.removed} removed)`);
  if (data.stats) {
    const set = cov.unmapped.length ? ` · ${cov.unmapped.length} set aside` : '';
    const part = cov.partial.length ? ` (${cov.partial.length} only in part)` : '';
    const expl = diffFiles ? ` · ${cov.explained.length} explained${part}${set} · ${cov.unexplained.length} unexplained` : '';
    console.log(`  ${data.stats.files} file${data.stats.files === 1 ? '' : 's'} changed, +${data.stats.additions} −${data.stats.deletions}${expl}`);
  }
  if (args.summary) console.log(`  summary: ${rel(path.resolve(args.summary))}`);
  if (checked) console.log(`  layout check: ${layout.length ? `${layout.length} problem${layout.length === 1 ? '' : 's'}` : 'ok'}`);
  for (const f of shots) console.log(`  screenshot: ${rel(f)}`);
  if (warnings.length) {
    console.log(`\nwarnings (${warnings.length}):`);
    for (const w of warnings) console.log(`  ! ${w}`);
  }
  if (layout.length) {
    console.log(`\nlayout (${layout.length}):`);
    for (const w of layout) console.log(`  ! ${w}`);
  }
  if (notes.length) {
    console.log('\nnotes:');
    for (const n of notes) console.log(`  · ${n}`);
  }
  if (args.strict && (warnings.length || layout.length)) {
    console.error('\nvisual-qa: --strict and there are warnings.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`visual-qa: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
