// End to end against a real temporary git repository: collect → spec → render.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COLLECT = path.join(ROOT, 'skills/visual-qa/scripts/collect.mjs');
const RENDER = path.join(ROOT, 'skills/visual-qa/scripts/render.mjs');

const BASE_DECIDE = `export function decide(refund) {
  // every refund waits for a person
  queue.add(refund);
  slack.post('#finance', refund.id);
  return 'pending';
}
`;
const HEAD_DECIDE = `import { smallAndSafe } from './rules.js';

export function decide(refund) {
  if (smallAndSafe(refund)) {
    pay(refund);
    return 'approved';
  }
  queue.add(refund);
  return 'pending';
}
`;

const NOTIFY = `import { mail } from './mail.js';
import { log } from './log.js';

export function notify(refund) {
  log('refund', refund.id);
  return mail(refund.email, 'refund-receipt'OPTS);
}

export const TEMPLATE = 'refund-receipt';
`;

let dir;
let git;
const write = (rel, text) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
};
const node = (script, args, opts = {}) => spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8', ...opts });
const embedded = (html) => JSON.parse(/<script type="application\/json" id="vqa-data">([\s\S]*?)<\/script>/.exec(html)[1]);

before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'visual-qa-test-'));
  git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('checkout', '-q', '-b', 'main');
  write('src/decide.js', BASE_DECIDE);
  write('src/notify.js', NOTIFY.replace('OPTS', ''));
  write('src/old-job.js', 'export function nightly() {\n  sendAll();\n}\n');
  write('README.md', '# demo\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature');
  write('src/decide.js', HEAD_DECIDE);
  write('src/rules.js', 'export const smallAndSafe = (r) => r.cents < 5000 && r.score < 30;\n');
  rmSync(path.join(dir, 'src/old-job.js'));
  git('mv', 'src/notify.js', 'src/notifications.js');
  write('src/notifications.js', NOTIFY.replace('OPTS', ', { now: true }'));
  write('docs/notes.md', 'unrelated notes\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feature');
});

after(() => rmSync(dir, { recursive: true, force: true }));

function collect(args = ['--base', 'main', '--head', 'feature']) {
  const r = node(COLLECT, args);
  assert.equal(r.status, 0, r.stderr);
  return { out: r.stdout, ctx: JSON.parse(readFileSync(path.join(dir, '.visual-qa/context.json'), 'utf8')) };
}

function specFrom(ctx, extra = {}) {
  return {
    version: 1,
    title: 'Auto-approve </script><script>alert(1)</script>',
    summary: 'Small refunds are paid at once.',
    pr: ctx.specPr,
    nodes: [
      { id: 'decide', title: 'Decide', col: 0, row: 0, status: 'changed', before: { sub: 'Queues every refund' }, sub: 'Pays small ones',
        detail: { summary: 'Small refunds skip the queue.', qa: [{ check: '$49.99', expect: 'paid' }], code: [{ path: 'src/decide.js', lines: '4-7' }] } },
      { id: 'rule', title: 'Small and safe?', shape: 'decision', col: 1, row: 0, status: 'added',
        detail: { summary: 'The new rule.', qa: ['$50.00 → queue'], code: [{ path: 'src/rules.js' }] } },
      { id: 'slack', title: 'Slack ping', col: 0, row: 1, status: 'removed',
        detail: { summary: 'No more Slack.', qa: ['No message'], code: [{ path: 'src/decide.js', side: 'base', lines: '4' }] } },
      { id: 'job', title: 'Nightly job', col: 1, row: 1, status: 'removed',
        detail: { summary: 'Deleted.', qa: ['Gone from cron'], code: [{ path: 'src/old-job.js', side: 'base' }] } },
      { id: 'notify', title: 'Notify', col: 2, row: 0, status: 'changed', before: { sub: 'Later' }, sub: 'Now',
        detail: { summary: 'Sends now.', qa: ['Email arrives'], code: [{ path: 'src/notify.js' }] } },
    ],
    edges: [
      { id: 'toRule', from: 'decide', to: 'rule', status: 'added', detail: { summary: 's', qa: ['q'], code: [{ path: 'src/decide.js', lines: '4' }] } },
      { id: 'ping', from: 'decide', to: 'slack', status: 'removed', detail: { summary: 's', qa: ['q'], code: [{ path: 'src/decide.js', side: 'base', lines: '4' }] } },
    ],
    ...extra,
  };
}

test('collect maps the branch against its merge-base', () => {
  const { out, ctx } = collect();
  assert.match(out, /visual-qa · change map/);
  assert.equal(ctx.base.sha, git('rev-parse', 'main').trim());
  assert.equal(ctx.head.sha, git('rev-parse', 'feature').trim());
  assert.equal(ctx.specPr.base, ctx.base.sha);
  const byPath = Object.fromEntries(ctx.files.map((f) => [f.path, f]));
  assert.equal(byPath['src/decide.js'].status, 'modified');
  assert.equal(byPath['src/rules.js'].status, 'added');
  assert.equal(byPath['src/old-job.js'].status, 'deleted');
  assert.equal(byPath['src/notifications.js'].status, 'renamed');
  assert.equal(byPath['src/notifications.js'].oldPath, 'src/notify.js');
  assert.equal(ctx.stats.files, 5);
});

test('collect lists what a new file defines, since its hunks carry no function names', () => {
  const { out, ctx } = collect();
  const rules = ctx.files.find((f) => f.path === 'src/rules.js');
  assert.deepEqual(rules.defines, [{ line: 1, label: 'const smallAndSafe' }]);
  assert.match(out, /A rules\.js .*⟶ const smallAndSafe :1/);
  assert.equal(ctx.files.find((f) => f.path === 'src/decide.js').defines, undefined, 'only new files');
});

test('"Open" links are left out until the commits are on the remote', () => {
  const { ctx } = collect();
  const specPath = path.join(dir, '.visual-qa/links.json');
  writeFileSync(specPath, JSON.stringify(specFrom(ctx, { pr: { ...ctx.specPr, repoUrl: 'https://example.com/acme/shop' } })));
  let r = node(RENDER, [specPath]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /aren't on the remote yet, as far as this clone knows, so the report leaves out "Open" links/);
  let data = embedded(readFileSync(path.join(dir, '.visual-qa/links.html'), 'utf8'));
  assert.deepEqual(data.generated.links, { base: false, head: false });

  // Once a remote-tracking branch holds both commits, the links are back.
  git('update-ref', 'refs/remotes/origin/main', 'main');
  git('update-ref', 'refs/remotes/origin/feature', 'feature');
  try {
    r = node(RENDER, [specPath]);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /on the remote yet/);
    data = embedded(readFileSync(path.join(dir, '.visual-qa/links.html'), 'utf8'));
    assert.deepEqual(data.generated.links, { base: true, head: true });
  } finally {
    git('update-ref', '-d', 'refs/remotes/origin/main');
    git('update-ref', '-d', 'refs/remotes/origin/feature');
  }
});

test('render checks code refs against the files, and coverage change by change', () => {
  const { ctx } = collect();
  const s = specFrom(ctx);
  s.nodes[1].detail.code = [{ path: 'src/rules.js', lines: '4-9', symbol: 'smallAndSafe' }];
  s.nodes[0].detail.code = [{ path: 'src/decide.js', lines: '4-7', symbol: 'refundAll' }];
  const specPath = path.join(dir, '.visual-qa/refs.json');
  writeFileSync(specPath, JSON.stringify(s));
  const r = node(RENDER, [specPath]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /src\/rules\.js has 1 line, so lines 4-9 are past its end/);
  assert.match(r.stdout, /"refundAll" isn't in src\/decide\.js/);
  const data = embedded(readFileSync(path.join(dir, '.visual-qa/refs.html'), 'utf8'));
  assert.ok(Array.isArray(data.coverage.partial));
});

test('render pulls real hunks from git, reports coverage, and escapes content', () => {
  const { ctx } = collect();
  const specPath = path.join(dir, '.visual-qa/spec.json');
  writeFileSync(specPath, JSON.stringify(specFrom(ctx, { unmapped: [{ path: 'README.md', reason: 'not changed' }] })));
  const r = node(RENDER, [specPath, '--summary', path.join(dir, '.visual-qa/summary.md')]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /wrote .*spec\.html/);
  assert.match(r.stdout, /docs\/notes\.md/, 'unexplained file is reported');
  assert.match(r.stdout, /unmapped "README\.md" doesn't match any changed file/);

  const html = readFileSync(path.join(dir, '.visual-qa/spec.html'), 'utf8');
  assert.ok(!html.includes('<script>alert(1)'), 'title cannot inject markup');
  const data = embedded(html);
  const decideRef = data.nodes[0].detail.code[0];
  assert.ok(decideRef.hunks.length > 0, 'hunks attached for the changed lines');
  const hunk = data.files['src/decide.js'].hunks[decideRef.hunks[0]];
  assert.ok(hunk.lines.some(([t, , , text]) => t === '+' && text.includes('smallAndSafe(refund)')));
  assert.ok(hunk.lines.some(([t, , , text]) => t === '-' && text.includes('slack.post')));
  assert.equal(data.nodes[3].detail.code[0].hunks.length, 1, 'deleted file resolves on the base side');
  assert.equal(data.nodes[4].detail.code[0].file, 'src/notifications.js', 'old path of a rename resolves');
  assert.deepEqual(data.coverage.unexplained.map((f) => f.path), ['docs/notes.md']);
  assert.equal(data.stats.files, 5);
  assert.equal(data.pr.base, ctx.base.sha);
  assert.equal(data.pr.head, ctx.head.sha);

  const md = readFileSync(path.join(dir, '.visual-qa/summary.md'), 'utf8');
  assert.match(md, /QA checklist/);
  assert.match(md, /docs\/notes\.md/);
});

test('--strict fails on warnings; errors write nothing', () => {
  const { ctx } = collect();
  const specPath = path.join(dir, '.visual-qa/strict.json');
  writeFileSync(specPath, JSON.stringify(specFrom(ctx)));
  const strict = node(RENDER, [specPath, '--strict']);
  assert.equal(strict.status, 1);

  const bad = specFrom(ctx);
  bad.edges.push({ id: 'oops', from: 'decide', to: 'nowhere' });
  const badPath = path.join(dir, '.visual-qa/bad.json');
  writeFileSync(badPath, JSON.stringify(bad));
  const r = node(RENDER, [badPath]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /"nowhere" isn't a node id/);
  assert.ok(!existsSync(path.join(dir, '.visual-qa/bad.html')));
});

test('worktree mode includes uncommitted changes', () => {
  write('src/rules.js', 'export const smallAndSafe = (r) => r.cents < 2500;\n');
  try {
    const { ctx } = collect(['--base', 'main', '--worktree']);
    assert.equal(ctx.worktree, true);
    assert.equal(ctx.specPr.head, 'WORKTREE');
    const rules = ctx.files.find((f) => f.path === 'src/rules.js');
    assert.ok(rules);
    const specPath = path.join(dir, '.visual-qa/wt.json');
    writeFileSync(specPath, JSON.stringify(specFrom(ctx)));
    const r = node(RENDER, [specPath]);
    assert.equal(r.status, 0, r.stderr);
    const data = embedded(readFileSync(path.join(dir, '.visual-qa/wt.html'), 'utf8'));
    assert.equal(data.generated.worktree, true);
    const lines = data.files['src/rules.js'].hunks.flatMap((hk) => hk.lines.map((l) => l[3]));
    assert.ok(lines.some((t) => t.includes('2500')), 'the uncommitted edit is in the diff');
  } finally {
    git('checkout', '--', 'src/rules.js');
  }
});
