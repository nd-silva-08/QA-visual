#!/usr/bin/env node
// Gather what a PR or branch changes: the exact before/after commits, the changed files, and the
// functions each hunk touches. Read-only, except that --pr may fetch the PR's head into
// refs/visual-qa/pr-<n> when it isn't available locally.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from './lib/args.mjs';
import { changedRanges, formatRanges, outline, parseUnifiedDiff } from './lib/diff.mjs';
import {
  currentBranch, defaultBranch, diffText, ghPrView, git, hasGh, mergeBase, remoteUrl, repoRoot,
  resolveCommit, toWebUrl, untrackedFiles,
} from './lib/git.mjs';
import { diffStats } from './lib/spec.mjs';
import { VERSION } from './lib/version.mjs';

const USAGE = `Usage: node collect.mjs [--pr <number|url>] [--base <ref>] [--head <ref>] [--worktree] [options]

Prints a change map for a pull request or branch and writes .visual-qa/context.json.

  --pr <n|url>       A GitHub pull request. Uses gh when installed, otherwise fetches pull/<n>/head.
  --base <ref>       The side being changed (default: the PR's base, else the default branch)
  --head <ref>       The changed side (default: the PR's head, else HEAD)
  --worktree         Compare the working tree, including uncommitted changes, against --base
  --repo <dir>       Repository to read (default: current directory)
  -o, --out <file>   Where to write the context JSON (default: <repo>/.visual-qa/context.json)
  --json             Print the JSON instead of the digest
  -h, --help         Show this help
`;

const short = (sha) => (sha ? String(sha).slice(0, 7) : '?');

function die(msg) {
  console.error(`visual-qa: ${msg}`);
  process.exit(1);
}

function prNumber(v) {
  const m = /(?:\/pull\/|^#?)(\d+)(?:[/?#].*)?$/.exec(String(v).trim());
  return m ? m[1] : null;
}

function fetchPrHead(n, root) {
  const ref = `refs/visual-qa/pr-${n}`;
  const ok = git(['fetch', '--no-tags', '--quiet', 'origin', `+pull/${n}/head:${ref}`], { cwd: root, allowFail: true });
  return ok === null ? null : resolveCommit(ref, root);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), { boolean: ['worktree', 'json', 'help'], alias: { o: 'out', h: 'help' } });
  } catch (e) {
    console.error(e.message);
    console.error(USAGE);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }

  let root;
  try {
    root = repoRoot(path.resolve(args.repo || process.cwd()));
  } catch (_) {
    die('not inside a git repository. Run this from the repo or pass --repo <dir>.');
  }

  const webUrl = toWebUrl(remoteUrl(root));
  let pr = null;
  let baseRef = args.base || null;
  let headRef = args.head || null;
  let headSha = null;

  if (args.pr) {
    const n = prNumber(args.pr);
    if (!n) die(`"${args.pr}" doesn't look like a PR number or URL.`);
    let meta = null;
    if (hasGh()) {
      try {
        meta = ghPrView(n, root);
      } catch (e) {
        console.error(`visual-qa: gh couldn't read PR #${n} (${String(e.stderr || e.message).trim().split('\n')[0]}); falling back to git.`);
      }
    }
    pr = { number: Number(n) };
    if (meta) {
      Object.assign(pr, { title: meta.title, url: meta.url, author: meta.author && meta.author.login, isDraft: meta.isDraft });
      baseRef = baseRef || `origin/${meta.baseRefName}`;
      pr.baseRef = meta.baseRefName;
      pr.headRef = meta.headRefName;
      if (!headRef) {
        headSha = resolveCommit(meta.headRefOid, root) || fetchPrHead(n, root);
        if (!headSha) die(`PR #${n}'s head ${short(meta.headRefOid)} isn't available locally and couldn't be fetched.`);
        if (headSha !== meta.headRefOid) console.error(`visual-qa: note: fetched PR head is ${short(headSha)}, GitHub reports ${short(meta.headRefOid)}.`);
      }
      if (!resolveCommit(baseRef, root)) git(['fetch', '--no-tags', '--quiet', 'origin', meta.baseRefName], { cwd: root, allowFail: true });
    } else if (!headRef) {
      headSha = fetchPrHead(n, root);
      if (!headSha) die(`couldn't fetch pull/${n}/head from origin. Install gh, or pass --base and --head yourself.`);
      pr.headRef = `pull/${n}/head`;
      if (webUrl) pr.url = `${webUrl}/pull/${n}`;
    }
  }

  if (args.worktree) headRef = 'WORKTREE';
  if (!headSha) {
    if (!headRef || headRef === 'WORKTREE') headSha = resolveCommit('HEAD', root);
    else headSha = resolveCommit(headRef, root);
    if (!headSha) die(`"${headRef}" isn't a commit here.`);
  }
  if (!baseRef) baseRef = defaultBranch(root);
  if (!baseRef) die('couldn\'t find a default branch to compare against. Pass --base <ref>.');
  const baseTip = resolveCommit(baseRef, root);
  if (!baseTip) die(`base "${baseRef}" isn't a commit here. Fetch it first (git fetch origin).`);
  const base = mergeBase(baseTip, headSha, root);
  if (!base) die(`${baseRef} and ${headRef || 'HEAD'} share no history, so there's nothing to compare.`);

  const worktree = headRef === 'WORKTREE';
  const files = parseUnifiedDiff(diffText(base, worktree ? 'WORKTREE' : headSha, root));
  const stats = diffStats(files);
  const headName = worktree ? (currentBranch(root) || 'HEAD') + ' + uncommitted changes' : (pr && pr.headRef) || headRef || currentBranch(root) || 'HEAD';
  const baseName = (pr && pr.baseRef) || String(baseRef).replace(/^origin\//, '');

  const ctx = {
    tool: 'visual-qa',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    repo: { root, webUrl },
    pr,
    base: { ref: baseName, tip: baseTip, sha: base },
    head: { ref: headName, sha: headSha },
    worktree,
    stats,
    files: files.map((f) => ({
      path: f.path,
      oldPath: f.oldPath || undefined,
      status: f.status,
      binary: f.binary || undefined,
      additions: f.additions,
      deletions: f.deletions,
      changed: changedRanges(f.hunks),
      hunks: f.hunks.map((hk) => ({ old: [hk.oldStart, hk.oldLines], new: [hk.newStart, hk.newLines], context: hk.header || undefined })),
      // A new file's hunks carry no function context, so list what it defines instead.
      defines: f.status === 'added' && !f.binary ? newDefinitions(f) : undefined,
    })),
    untracked: worktree ? untrackedFiles(root) : undefined,
    specPr: {
      ...(pr && pr.number ? { number: pr.number } : {}),
      ...(pr && pr.title ? { title: pr.title } : {}),
      ...(pr && pr.url ? { url: pr.url } : {}),
      ...(pr && pr.author ? { author: pr.author } : {}),
      baseRef: baseName,
      headRef: worktree ? currentBranch(root) || 'HEAD' : headName,
      base,
      head: worktree ? 'WORKTREE' : headSha,
      ...(webUrl ? { repoUrl: webUrl } : {}),
    },
  };

  const out = path.resolve(args.out || path.join(root, '.visual-qa', 'context.json'));
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(ctx, null, 2) + '\n');

  if (args.json) {
    console.log(JSON.stringify(ctx, null, 2));
    return;
  }
  console.log(digest(ctx, path.relative(process.cwd(), out) || out));
}

function newDefinitions(f) {
  const lines = f.hunks.flatMap((hk) => hk.lines.filter((l) => l[0] === '+').map((l) => [l[2], l[3]]));
  const found = outline(lines);
  return found.length ? found : undefined;
}

const LETTER = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C' };

function digest(ctx, outPath) {
  const L = [];
  L.push('visual-qa · change map');
  L.push(`  repo    ${ctx.repo.webUrl || ctx.repo.root}`);
  if (ctx.pr && ctx.pr.number) L.push(`  pr      #${ctx.pr.number}${ctx.pr.title ? ' ' + ctx.pr.title : ''}${ctx.pr.isDraft ? ' (draft)' : ''}`);
  L.push(`  before  ${ctx.base.ref} @ ${short(ctx.base.sha)}  (merge-base${ctx.base.tip !== ctx.base.sha ? `; ${ctx.base.ref} is now at ${short(ctx.base.tip)}` : ''})`);
  L.push(`  after   ${ctx.head.ref} @ ${ctx.worktree ? 'working tree' : short(ctx.head.sha)}`);
  L.push(`  changed ${ctx.stats.files} file${ctx.stats.files === 1 ? '' : 's'}, +${ctx.stats.additions} −${ctx.stats.deletions}`);
  L.push('');
  if (!ctx.files.length) {
    L.push('  No differences. There is nothing to diagram.');
  } else {
    const byDir = new Map();
    for (const f of ctx.files) {
      const dir = path.posix.dirname(f.path);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(f);
    }
    let shown = 0;
    for (const [dir, list] of [...byDir.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (shown >= 300) break;
      L.push(`  ${dir === '.' ? '(root)' : dir + '/'}`);
      for (const f of list) {
        if (shown++ >= 300) break;
        const name = path.posix.basename(f.path);
        const was = f.oldPath ? `  (was ${f.oldPath})` : '';
        const counts = f.binary ? 'binary' : `+${f.additions} −${f.deletions}`;
        const ctxs = f.defines
          ? f.defines.map((d) => `${d.label} :${d.line}`)
          : [...new Set(f.hunks.map((hk) => (hk.context || '').trim()).filter(Boolean))];
        const where = ctxs.length ? `  ⟶ ${ctxs.slice(0, 4).map((c) => (c.length > 60 ? c.slice(0, 57) + '…' : c)).join(' | ')}${ctxs.length > 4 ? ` (+${ctxs.length - 4})` : ''}` : '';
        const cap = (rs) => formatRanges(rs.slice(0, 8)) + (rs.length > 8 ? ', …' : '');
        let ranges = '';
        if (f.status === 'added' && f.changed.head.length === 1) ranges = '  (new file)';
        else if (f.status === 'deleted') ranges = '  (deleted file)';
        else if (f.changed.head.length) ranges = `  lines ${cap(f.changed.head)}${f.changed.base.length ? `; removed before-lines ${cap(f.changed.base)}` : ''}`;
        else if (f.changed.base.length) ranges = `  removed before-lines ${cap(f.changed.base)}`;
        L.push(`    ${LETTER[f.status] || 'M'} ${name}${was}  ${counts}${ranges}${where}`);
      }
    }
    if (ctx.files.length > 300) L.push(`  … and ${ctx.files.length - 300} more files (see the JSON)`);
  }
  if (ctx.untracked && ctx.untracked.length) {
    L.push('', `  note: ${ctx.untracked.length} untracked file(s) are not in the diff: ${ctx.untracked.slice(0, 8).join(', ')}${ctx.untracked.length > 8 ? ', …' : ''}`);
  }
  L.push('');
  L.push(`Wrote ${outPath}`);
  L.push(`Before code: git show ${short(ctx.base.sha)}:<path>    After code: ${ctx.worktree ? 'the working tree' : `git show ${short(ctx.head.sha)}:<path>`}`);
  L.push(`"lines" are changed after-side lines: use them for detail.code "lines". "removed before-lines" need "side": "base".`);
  if (ctx.files.some((f) => f.defines)) L.push('For a new file, ⟶ lists what it defines and the line each starts on (all of them are in the JSON).');
  L.push(`Spec "pr" block: ${JSON.stringify(ctx.specPr)}`);
  return L.join('\n');
}

main();
