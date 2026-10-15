import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Who and where, for the rows `roost export` sends: a pseudonymous person id and a repo id that's the same on every
 * machine (github.com/org/repo). Read from git's config files; nothing is executed.
 */

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** The [section "name"] key = value pairs of a git config file (the subset roost needs). */
export function gitConfigValue(text: string, section: string, key: string): string | undefined {
  let current = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const head = /^\[\s*([^\]\s"]+)(?:\s+"([^"]*)")?\s*\]$/.exec(line);
    if (head) { current = head[2] !== undefined ? `${head[1].toLowerCase()} "${head[2]}"` : head[1].toLowerCase(); continue; }
    if (current !== section) continue;
    const kv = /^([A-Za-z][\w-]*)\s*=\s*(.*)$/.exec(line);
    if (kv && kv[1].toLowerCase() === key.toLowerCase()) return kv[2].replace(/^"(.*)"$/, '$1').trim();
  }
  return undefined;
}

/**
 * A remote URL as host/org/repo, without credentials, port, scheme or .git:
 * git@github.com:acme/shop.git, https://user:token@github.com/acme/shop, ssh://git@host:22/acme/shop.git → host/acme/shop.
 */
export function normaliseRemote(url: string): string | undefined {
  const u = url.trim();
  let host: string, path: string;
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(u);   // git@github.com:acme/shop.git
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    try { const p = new URL(u); host = p.hostname; path = p.pathname; } catch { return undefined; }
  } else if (scp) { host = scp[1]; path = scp[2]; } else return undefined;
  path = path.replace(/^\/+/, '').replace(/\.git\/?$/, '').replace(/\/+$/, '');
  if (!host || !path) return undefined;
  // SSH host aliases for a second account (git@github.com-work:org/repo) are the same host.
  const alias = /^(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)[-_.].+$/i.exec(host);
  return `${(alias ? alias[1] : host).toLowerCase()}/${path}`;
}

const repoCache = new Map<string, string | undefined>();

/** The repo's origin (or first) remote, normalised; worktrees resolve to their main repo's config. */
export function repoRemote(repoRoot: string): string | undefined {
  if (repoCache.has(repoRoot)) return repoCache.get(repoRoot);
  let configPath = join(repoRoot, '.git', 'config');
  try {
    if (statSync(join(repoRoot, '.git')).isFile()) {
      const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(repoRoot, '.git'), 'utf8'))?.[1]?.trim();
      if (gitdir) {
        const dir = isAbsolute(gitdir) ? gitdir : resolve(repoRoot, gitdir);
        configPath = /[\\/]worktrees[\\/][^\\/]+$/.test(dir) ? join(dirname(dirname(dir)), 'config') : join(dir, 'config');
      }
    }
  } catch { /* no .git */ }
  let remote: string | undefined;
  try {
    const text = readFileSync(configPath, 'utf8');
    const url = gitConfigValue(text, 'remote "origin"', 'url') ?? /\[remote "[^"]+"\][^[]*?\burl\s*=\s*(\S+)/.exec(text)?.[1];
    remote = url ? normaliseRemote(url) : undefined;
  } catch { /* no config */ }
  repoCache.set(repoRoot, remote);
  return remote;
}

/** How a repo is labelled in what's sent. */
export function repoLabel(repoRoot: string | undefined, mode: 'remote' | 'name' | 'none'): string | undefined {
  if (mode === 'none') return undefined;
  if (!repoRoot) return 'unknown';
  if (mode === 'remote') return repoRemote(repoRoot) ?? basename(repoRoot);
  return basename(repoRoot);
}

/** A random id for this machine (~/.roost/instance-id), used when person ids are off. It says nothing about who. */
export function machineId(home = homedir()): string {
  const file = join(home, '.roost', 'instance-id');
  try { const id = readFileSync(file, 'utf8').trim(); if (/^[0-9a-f]{16}$/.test(id)) return id; } catch { /* first time */ }
  const id = randomBytes(8).toString('hex');
  try { mkdirSync(join(home, '.roost'), { recursive: true, mode: 0o700 }); writeFileSync(file, id + '\n', { mode: 0o600 }); } catch { /* read-only home: a fresh id each run */ }
  return id;
}

/** A stable pseudonymous id: sha256 of the company salt and the git email (or user@host), 16 hex characters. */
export function personId(salt: string, home = homedir()): string {
  let who: string | undefined;
  for (const f of [join(home, '.gitconfig'), join(home, '.config', 'git', 'config')]) {
    try { who = gitConfigValue(readFileSync(f, 'utf8'), 'user', 'email'); } catch { /* none */ }
    if (who) break;
  }
  if (!who) { let user = 'unknown'; try { user = userInfo().username; } catch { /* none */ } who = `${user}@${hostname()}`; }
  return sha(`${salt}:${who.toLowerCase()}`).slice(0, 16);
}
