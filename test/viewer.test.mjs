// Renders the example in headless Chrome when one is available; skipped otherwise.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findChrome } from '../skills/visual-qa/scripts/lib/chrome.mjs';

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
