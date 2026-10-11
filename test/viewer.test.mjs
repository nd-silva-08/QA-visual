// Renders the example in headless Chrome when one is available; skipped otherwise.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findChrome, layoutReport } from '../skills/visual-qa/scripts/lib/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = findChrome();

test('the example renders in a browser and passes the layout check', { skip: chrome ? false : 'no Chrome/Chromium found' }, () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'visual-qa-view-'));
  try {
    const r = spawnSync(process.execPath, [
      path.join(ROOT, 'skills/visual-qa/scripts/render.mjs'),
      path.join(ROOT, 'skills/visual-qa/assets/example-spec.json'),
      '-o', path.join(tmp, 'demo.html'), '--no-git', '--check', '--screenshot', path.join(tmp, 'shot'),
    ], { encoding: 'utf8', timeout: 180000 });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /layout check: (ok|\d+ problem)/, r.stdout);
    assert.doesNotMatch(r.stdout, /failed to render/);
    assert.equal((r.stdout.match(/screenshot: /g) || []).length, 4);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a section with only new parts says so in Before; one with only removed parts in the clean After', { skip: chrome ? false : 'no Chrome/Chromium found' }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'visual-qa-view-'));
  const detail = { summary: 's', qa: ['q'], code: [{ path: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b' }] };
  const spec = {
    version: 1, title: 'Empty sections',
    sections: [{ id: 'old', title: 'Old' }, { id: 'new', title: 'New' }, { id: 'gone', title: 'Gone' }],
    nodes: [
      { id: 'a', title: 'A', section: 'old', col: 0, row: 0 },
      { id: 'b', title: 'B', section: 'new', col: 1, row: 0, status: 'added', detail },
      { id: 'c', title: 'C', section: 'gone', col: 1, row: 0, status: 'removed', detail },
    ],
    edges: [],
  };
  try {
    writeFileSync(path.join(tmp, 'spec.json'), JSON.stringify(spec));
    const r = spawnSync(process.execPath, [
      path.join(ROOT, 'skills/visual-qa/scripts/render.mjs'), path.join(tmp, 'spec.json'), '-o', path.join(tmp, 'page.html'), '--no-git',
    ], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const rep = await layoutReport(chrome, pathToFileURL(path.join(tmp, 'page.html')).href);
    assert.deepEqual(rep.diagrams[0].empty, { before: ['new'], after: ['gone'] });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
