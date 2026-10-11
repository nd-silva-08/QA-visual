// Read-only git helpers. Nothing here changes the working tree, the index, or any branch.
import { execFileSync } from 'node:child_process';

export function git(args, { cwd, allowFail = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (allowFail) return null;
    const msg = String(err.stderr || '').trim() || err.message;
    throw new Error(`git ${args.join(' ')} failed: ${msg}`);
  }
}

export function repoRoot(cwd) {
  return git(['rev-parse', '--show-toplevel'], { cwd }).trim();
}

export function resolveCommit(ref, cwd) {
  const out = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, allowFail: true });
  return out ? out.trim() : null;
}

export function mergeBase(a, b, cwd) {
  const out = git(['merge-base', a, b], { cwd, allowFail: true });
  return out ? out.trim() : null;
}

/** origin/HEAD's target, else the first of origin/main, origin/master, main, master that exists. */
export function defaultBranch(cwd) {
  const sym = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd, allowFail: true });
  if (sym && sym.trim()) return sym.trim().replace(/^refs\/remotes\//, '');
  for (const ref of ['origin/main', 'origin/master', 'main', 'master', 'origin/develop', 'develop']) {
    if (resolveCommit(ref, cwd)) return ref;
  }
  return null;
}

export function currentBranch(cwd) {
  const out = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, allowFail: true });
  const b = out ? out.trim() : '';
  return b && b !== 'HEAD' ? b : null;
}

/**
 * Whether the commit is on a remote, judged from the remote-tracking branches and fetched PR heads
 * as of the last fetch or push. A commit that is only local can't be opened on the web yet.
 */
export function onRemote(sha, cwd) {
  const out = git(['for-each-ref', '--count=1', '--format=%(refname)', '--contains', sha, 'refs/remotes', 'refs/visual-qa'], { cwd, allowFail: true });
  return !!(out && out.trim());
}

/** A file's text at a commit, or null when it isn't there or can't be read. */
export function fileAt(sha, file, cwd) {
  return git(['-c', 'core.quotePath=false', 'show', `${sha}:${file}`], { cwd, allowFail: true });
}

export function remoteUrl(cwd) {
  const out = git(['config', '--get', 'remote.origin.url'], { cwd, allowFail: true });
  return out ? out.trim() : null;
}

/** Turn a remote URL into a browsable https URL, dropping any embedded credentials. */
export function toWebUrl(url) {
  if (!url) return null;
  const m = /^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?\/?$/.exec(url); // git@host:owner/repo.git
  if (m) return `https://${m[1]}/${m[2]}`;
  try {
    const u = new URL(url);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(u.protocol)) return null;
    const path = u.pathname.replace(/\.git$/, '').replace(/\/+$/, '');
    if (!path || path === '/') return null;
    return `https://${u.hostname}${path}`;
  } catch (_) {
    return null;
  }
}

export function diffText(base, head, cwd) {
  const args = [
    '-c', 'core.quotePath=false',
    'diff', '--no-color', '--no-ext-diff', '--no-textconv',
    '--src-prefix=a/', '--dst-prefix=b/', '-M', '--unified=3', base,
  ];
  if (head && head !== 'WORKTREE') args.push(head);
  return git(args, { cwd });
}

export function untrackedFiles(cwd) {
  const out = git(['ls-files', '--others', '--exclude-standard'], { cwd, allowFail: true });
  return out ? out.split('\n').filter(Boolean) : [];
}

export function hasGh() {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

export function ghPrView(pr, cwd) {
  const fields = 'number,title,url,author,baseRefName,headRefName,baseRefOid,headRefOid,isDraft,additions,deletions,changedFiles';
  const out = execFileSync('gh', ['pr', 'view', String(pr), '--json', fields], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
}
