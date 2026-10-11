// Headless Chrome/Chromium helpers for the layout check and screenshots. Optional: everything
// else works without a browser. Chrome sometimes keeps running after it has finished (updater
// and helper processes), so these helpers take the output as soon as it exists and then stop
// the whole process group instead of waiting for Chrome to exit by itself.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function findChrome() {
  for (const v of [process.env.VISUAL_QA_CHROME, process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH]) {
    if (v && existsSync(v)) return v;
  }
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ],
    win32: [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    ],
  }[process.platform] || [];
  for (const p of candidates) if (existsSync(p)) return p;
  if (process.platform !== 'win32') {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
      const r = spawnSync('which', [name], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    }
  }
  return null;
}

const FLAGS = [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
  '--disable-component-update', '--disable-sync', '--disable-default-apps', '--no-service-autorun',
  '--password-store=basic', '--use-mock-keychain', '--disable-features=Translate,OptimizationHints,MediaRouter',
];

/**
 * Run Chrome until `ready(stdout)` says the output is complete (or Chrome exits), then stop it.
 * Resolves with stdout; rejects on timeout without usable output.
 */
function runChrome(chrome, extra, ready, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const profile = mkdtempSync(path.join(os.tmpdir(), 'visual-qa-chrome-'));
    const args = [...FLAGS, `--user-data-dir=${profile}`, ...extra];
    if (process.platform === 'linux') args.push('--no-sandbox', '--disable-dev-shm-usage');
    const posix = process.platform !== 'win32';
    const child = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'ignore'], detached: posix });
    let out = '';
    let settled = false;
    let poll = null;
    const stop = () => {
      try {
        if (posix) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (_) { /* already gone */ }
    };
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      stop();
      setTimeout(() => rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), 300).unref();
      if (err) reject(err);
      else resolve(out);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (ready(out)) finish(null);
    });
    child.on('error', (e) => finish(e));
    child.on('exit', () => setTimeout(() => finish(ready(out, true) ? null : new Error('Chrome exited without producing output')), 50));
    poll = setInterval(() => { if (ready(out)) finish(null); }, 200);
    const timer = setTimeout(() => finish(ready(out, true) ? null : new Error(`Chrome didn't finish within ${timeout / 1000}s`)), timeout);
  });
}

/** Load the page in check mode and return the layout report the viewer writes. */
export async function layoutReport(chrome, fileUrl) {
  const dom = await runChrome(chrome, ['--virtual-time-budget=15000', '--dump-dom', fileUrl + '#check'], (out) => out.includes('</html>'));
  const m = /<script[^>]*id="vqa-report"[^>]*>([\s\S]*?)<\/script>/.exec(dom);
  if (!m) {
    const err = /<pre class="vqa-error">([\s\S]*?)<\/pre>/.exec(dom);
    throw new Error(err ? decode(err[1]) : 'the page did not finish rendering');
  }
  return JSON.parse(m[1]);
}

/** Screenshot one diagram view at 1:1 (the viewer's screenshot mode shows only the canvas). */
export function screenshot(chrome, fileUrl, out, { width, height, diagram, view, scale = 1 }) {
  const hash = new URLSearchParams({ shot: '1', diagram, view }).toString();
  return screenshotUrl(chrome, `${fileUrl}#${hash}`, out, { width, height, scale });
}

/** Screenshot any URL at the given viewport size. */
export async function screenshotUrl(chrome, url, out, { width, height, scale = 1 }) {
  rmSync(out, { force: true });
  let lastSize = -1;
  const written = () => {
    try {
      const size = statSync(out).size;
      const stable = size > 0 && size === lastSize;
      lastSize = size;
      return stable;
    } catch (_) {
      return false;
    }
  };
  await runChrome(chrome, [
    `--window-size=${Math.ceil(width)},${Math.ceil(height)}`,
    `--force-device-scale-factor=${scale}`,
    '--virtual-time-budget=15000',
    `--screenshot=${out}`,
    url,
  ], (_, exited) => written() || (exited && existsSync(out)));
  return existsSync(out);
}

function decode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
