'use strict';

/**
 * Workspace allow-list: the ONLY place where the MCP server touches the filesystem.
 *
 * Convention: a workspace folder holds plain JSON files.
 *   - Postman v2.1 collection  -> { info, item[] }           (also { collection: {...} })
 *   - Postman/Apilix environment -> { name, values[] }       (also { environment: {...} })
 *   - Apilix workspace data file -> { collections[], environments[] }
 *     (workspaces/<id>.json from the desktop app, copied or exported into the folder)
 * Files are classified by content, not by name. Only *.json, never followed through
 * symlinks that leave the folder, never larger than maxFileBytes.
 *
 * Guarantees (and limits) are documented in wiki/MCP-Server.md.
 */

const fs = require('node:fs/promises');
const fsc = require('node:fs').constants;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_REL_LENGTH = 512;
const MAX_SEGMENTS = 8;
const MAX_SCAN_DEPTH = 4;
const MAX_SCAN_FILES = 1000;
const MAX_SCAN_BYTES = 128 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn']);
const SKIP_FILES = /^(package(-lock)?|tsconfig(\..*)?|npm-shrinkwrap|composer|\.eslintrc.*)\.json$/i;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

class WorkspaceError extends Error {
  constructor(message, code = 'EWORKSPACE') {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * Validate a workspace-relative path supplied by the agent and return its segments.
 * Rejects (before touching the disk): NUL, backslashes, ':' (drive letters, NTFS ADS,
 * 'C:foo' drive-relative), absolute and UNC paths, '.'/'..'/empty segments, Windows
 * device names, trailing dot/space segments, non-.json names.
 */
function parseRelativePath(rel, { requireJson = true } = {}) {
  if (typeof rel !== 'string' || rel.length === 0) throw new WorkspaceError('Path must be a non-empty string', 'EBADPATH');
  if (rel.length > MAX_REL_LENGTH) throw new WorkspaceError('Path is too long', 'EBADPATH');
  if (rel.includes('\0')) throw new WorkspaceError('Path contains a NUL byte', 'EBADPATH');
  if (rel.includes('\\')) throw new WorkspaceError('Backslashes are not allowed; use "/" separators', 'EBADPATH');
  if (rel.includes(':')) throw new WorkspaceError('":" is not allowed in paths (drive letters / alternate data streams)', 'EBADPATH');
  if (rel.startsWith('/')) throw new WorkspaceError('Absolute paths are not allowed; use a path relative to the workspace', 'EBADPATH');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(rel)) throw new WorkspaceError('Path contains control characters', 'EBADPATH');
  const segments = rel.split('/');
  if (segments.length > MAX_SEGMENTS) throw new WorkspaceError('Path is too deep', 'EBADPATH');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') throw new WorkspaceError('Path may not contain empty, "." or ".." segments', 'EBADPATH');
    if (/[. ]$/.test(seg)) throw new WorkspaceError('Path segments may not end with "." or a space', 'EBADPATH');
    if (WINDOWS_RESERVED.test(seg)) throw new WorkspaceError('Reserved device names are not allowed', 'EBADPATH');
    if (/[<>"|?*]/.test(seg)) throw new WorkspaceError('Path contains characters that are not allowed', 'EBADPATH');
  }
  if (requireJson && !/\.json$/i.test(segments[segments.length - 1])) {
    throw new WorkspaceError('Only .json files are allowed', 'EBADPATH');
  }
  return segments;
}

function sanitizeLabel(name) {
  const cleaned = String(name || 'workspace').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned || 'workspace';
}

/**
 * Classify a parsed JSON document. Returns { collections: [{index, value}], environments: [...] }.
 */
function classify(doc) {
  const out = { collections: [], environments: [] };
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return out;
  const isCollection = (c) => c && typeof c === 'object' && c.info && typeof c.info === 'object' && Array.isArray(c.item);
  const isEnvironment = (e) => e && typeof e === 'object' && Array.isArray(e.values) && typeof e.name === 'string';

  if (Array.isArray(doc.collections) || Array.isArray(doc.environments)) {
    (doc.collections || []).forEach((c, i) => { if (isCollection(c)) out.collections.push({ sub: String(i), value: c }); });
    (doc.environments || []).forEach((e, i) => { if (isEnvironment(e)) out.environments.push({ sub: String(i), value: e }); });
    return out;
  }
  const col = isCollection(doc) ? doc : (isCollection(doc.collection) ? doc.collection : null);
  if (col) { out.collections.push({ sub: null, value: col }); return out; }
  const env = isEnvironment(doc) ? doc : (isEnvironment(doc.environment) ? doc.environment : null);
  if (env) out.environments.push({ sub: null, value: env });
  return out;
}

/**
 * @param {object} opts
 * @param {string[]} opts.roots absolute folders (already resolved against cwd)
 * @param {number} opts.maxFileBytes
 * @param {boolean} [opts.explicit] true when the roots came from --workspace
 */
async function createWorkspaces({ roots, maxFileBytes, explicit = true }) {
  if (!Array.isArray(roots) || roots.length === 0) throw new WorkspaceError('At least one workspace folder is required');
  const home = await fs.realpath(os.homedir()).catch(() => os.homedir());
  const resolved = [];
  const warnings = [];
  for (const r of roots) {
    let real;
    try { real = await fs.realpath(r); } catch { throw new WorkspaceError(`Workspace folder does not exist: ${r}`); }
    const st = await fs.stat(real);
    if (!st.isDirectory()) throw new WorkspaceError(`Workspace is not a directory: ${r}`);
    if (path.parse(real).root === real) throw new WorkspaceError('Refusing to use the filesystem root as a workspace');
    if (real === home) {
      if (!explicit) throw new WorkspaceError('Refusing to use the home directory as the default workspace; pass --workspace <folder> explicitly');
      warnings.push('The home directory is exposed as a workspace: every collection/environment JSON file below it is reachable. Prefer a dedicated folder.');
    }
    if (!resolved.some((x) => x.real === real)) resolved.push({ real, label: '' });
  }
  const used = new Set();
  for (const w of resolved) {
    let label = sanitizeLabel(path.basename(w.real));
    let n = 1;
    while (used.has(label)) { n += 1; label = `${sanitizeLabel(path.basename(w.real))}-${n}`; }
    used.add(label);
    w.label = label;
  }
  const multi = resolved.length > 1;
  const scanCache = new Map(); // abs -> { mtimeMs, size, classes }

  function formatId(root, rel, sub) {
    const base = multi ? `${root.label}:${rel}` : rel;
    return sub === null || sub === undefined ? base : `${base}#${sub}`;
  }

  /** Split an id (as produced by formatId) into { root, rel, sub }. */
  function parseId(id) {
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_REL_LENGTH + 40) throw new WorkspaceError('Invalid id', 'EBADPATH');
    let rest = id;
    let sub = null;
    const hash = rest.lastIndexOf('#');
    if (hash >= 0) {
      sub = rest.slice(hash + 1);
      rest = rest.slice(0, hash);
      if (!/^\d{1,6}$/.test(sub)) throw new WorkspaceError('Invalid id', 'EBADPATH');
    }
    let root;
    if (multi) {
      const colon = rest.indexOf(':');
      if (colon <= 0) throw new WorkspaceError('Several workspaces are configured: ids must look like "<workspace>:<file>"', 'EBADPATH');
      const label = rest.slice(0, colon);
      root = resolved.find((w) => w.label === label);
      if (!root) throw new WorkspaceError('Unknown workspace in id', 'ENOTFOUND');
      rest = rest.slice(colon + 1);
    } else {
      root = resolved[0];
    }
    return { root, rel: rest, sub };
  }

  /**
   * Open a file for reading inside a root: realpath BEFORE open, O_NOFOLLOW open, realpath AFTER open,
   * identity check (dev/ino) between the opened handle and the resolved path, size limit.
   */
  async function readJsonSafe(root, rel) {
    const segments = parseRelativePath(rel);
    const abs = path.join(root.real, ...segments);
    let before;
    try { before = await fs.realpath(abs); } catch { throw new WorkspaceError('File not found in workspace', 'ENOTFOUND'); }
    if (!isInside(root.real, before) || before === root.real) throw new WorkspaceError('Path escapes the workspace', 'EESCAPE');
    let fh;
    try {
      fh = await fs.open(before, fsc.O_RDONLY | (fsc.O_NOFOLLOW || 0));
    } catch (e) {
      throw new WorkspaceError(e && e.code === 'ELOOP' ? 'Symbolic links are not followed' : 'Unable to open file', 'ENOTFOUND');
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new WorkspaceError('Not a regular file', 'EBADPATH');
      if (st.size > maxFileBytes) throw new WorkspaceError(`File is larger than the ${maxFileBytes}-byte limit`, 'ETOOLARGE');
      let after;
      try { after = await fs.realpath(abs); } catch { throw new WorkspaceError('File changed while opening', 'ERACE'); }
      if (after !== before || !isInside(root.real, after)) throw new WorkspaceError('Path escapes the workspace', 'EESCAPE');
      const lst = await fs.lstat(after);
      if (lst.ino !== st.ino || lst.dev !== st.dev) throw new WorkspaceError('File changed while opening', 'ERACE');
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) {
        const { bytesRead } = await fh.read(buf, off, st.size - off, off);
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      let text = buf.subarray(0, off).toString('utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      let doc;
      try { doc = JSON.parse(text); } catch { throw new WorkspaceError('File is not valid JSON', 'EBADJSON'); }
      return { doc, stat: st, real: after };
    } finally {
      await fh.close();
    }
  }

  async function scanRoot(root) {
    const found = [];
    let visited = 0;
    let skipped = 0;
    let scannedBytes = 0;
    async function walk(dir, relDir, depth) {
      if (depth > MAX_SCAN_DEPTH || visited >= MAX_SCAN_FILES) return;
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const ent of entries) {
        if (visited >= MAX_SCAN_FILES) return;
        if (ent.isSymbolicLink()) continue; // never traverse or list symlinks
        const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) continue;
          await walk(path.join(dir, ent.name), rel, depth + 1);
        } else if (ent.isFile() && /\.json$/i.test(ent.name) && !SKIP_FILES.test(ent.name)) {
          visited += 1;
          try { parseRelativePath(rel); } catch { continue; }
          const abs = path.join(root.real, ...rel.split('/'));
          let st;
          try { st = await fs.stat(abs); } catch { continue; }
          if (st.size > maxFileBytes) { skipped += 1; continue; }
          scannedBytes += st.size;
          if (scannedBytes > MAX_SCAN_BYTES) return;
          let cached = scanCache.get(abs);
          if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
            try {
              const { doc } = await readJsonSafe(root, rel);
              cached = { mtimeMs: st.mtimeMs, size: st.size, classes: classify(doc) };
            } catch {
              cached = { mtimeMs: st.mtimeMs, size: st.size, classes: classify(null) };
            }
            scanCache.set(abs, cached);
          }
          for (const c of cached.classes.collections) {
            found.push({ kind: 'collection', root, rel, sub: c.sub, id: formatId(root, rel, c.sub), name: String(c.value.info.name || rel).slice(0, 200), value: c.value });
          }
          for (const e of cached.classes.environments) {
            found.push({ kind: 'environment', root, rel, sub: e.sub, id: formatId(root, rel, e.sub), name: String(e.value.name || rel).slice(0, 200), value: e.value });
          }
        }
      }
    }
    await walk(root.real, '', 0);
    return { found, skipped };
  }

  /** Index of every collection/environment reachable from the allow-listed roots. */
  async function index() {
    const entries = [];
    let skippedLarge = 0;
    for (const root of resolved) {
      const r = await scanRoot(root);
      entries.push(...r.found);
      skippedLarge += r.skipped;
    }
    return {
      collections: entries.filter((e) => e.kind === 'collection'),
      environments: entries.filter((e) => e.kind === 'environment'),
      skippedLarge,
    };
  }

  async function loadEntity(kind, id) {
    const { root, rel, sub } = parseId(id);
    const { doc } = await readJsonSafe(root, rel);
    const classes = classify(doc);
    const list = kind === 'collection' ? classes.collections : classes.environments;
    const hit = list.find((c) => c.sub === sub);
    if (!hit) throw new WorkspaceError(`No ${kind} found with that id`, 'ENOTFOUND');
    return { kind, id: formatId(root, rel, sub), rel, root, sub, value: hit.value };
  }

  const loadCollection = (id) => loadEntity('collection', id);
  const loadEnvironment = (id) => loadEntity('environment', id);

  /**
   * Atomic write of a JSON text inside a root. Never follows or replaces symlinks, never
   * overwrites without `overwrite`, and only overwrites files that are recognised collections.
   */
  async function writeJsonAtomic(rootRef, rel, text, { overwrite = false } = {}) {
    const root = rootRef ? resolved.find((w) => w.label === rootRef) : (resolved.length === 1 ? resolved[0] : null);
    if (!root) throw new WorkspaceError('Specify which workspace to write to (one of: ' + resolved.map((w) => w.label).join(', ') + ')', 'EBADPATH');
    const segments = parseRelativePath(rel);
    if (segments.some((s) => s.startsWith('.'))) throw new WorkspaceError('Hidden files and folders are not allowed', 'EBADPATH');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > maxFileBytes) throw new WorkspaceError(`Content is larger than the ${maxFileBytes}-byte limit`, 'ETOOLARGE');
    const name = segments[segments.length - 1];
    const parentAbs = path.join(root.real, ...segments.slice(0, -1));
    let parentReal;
    try { parentReal = await fs.realpath(parentAbs); } catch { throw new WorkspaceError('Target folder does not exist inside the workspace', 'ENOTFOUND'); }
    if (!isInside(root.real, parentReal)) throw new WorkspaceError('Path escapes the workspace', 'EESCAPE');
    const target = path.join(parentReal, name);

    let existing = null;
    try { existing = await fs.lstat(target); } catch { /* absent */ }
    if (existing) {
      if (existing.isSymbolicLink()) throw new WorkspaceError('Refusing to write through a symbolic link', 'EESCAPE');
      if (!existing.isFile()) throw new WorkspaceError('Target is not a regular file', 'EBADPATH');
      if (!overwrite) throw new WorkspaceError('File already exists; pass overwrite:true to replace it', 'EEXIST');
      let recognised = false;
      try {
        const { doc } = await readJsonSafe(root, segments.join('/'));
        const c = classify(doc);
        recognised = c.collections.length > 0 || c.environments.length > 0;
      } catch { recognised = false; }
      if (!recognised) throw new WorkspaceError('Refusing to overwrite a file that is not a recognised collection/environment', 'EBADPATH');
    }

    const tmp = path.join(parentReal, `.apilix-mcp-${crypto.randomBytes(8).toString('hex')}.tmp`);
    let fh;
    try {
      fh = await fs.open(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | (fsc.O_NOFOLLOW || 0), 0o644);
      await fh.writeFile(text, 'utf8');
      await fh.sync().catch(() => {});
      await fh.close();
      fh = null;
      // Re-check the parent after writing: it must still resolve inside the root.
      const parentAfter = await fs.realpath(parentAbs);
      if (parentAfter !== parentReal) throw new WorkspaceError('Folder changed while writing', 'ERACE');
      if (overwrite) {
        await fs.rename(tmp, target);
      } else {
        try {
          await fs.link(tmp, target); // atomic, fails with EEXIST instead of clobbering
        } catch (e) {
          if (e && e.code === 'EEXIST') throw new WorkspaceError('File already exists; pass overwrite:true to replace it', 'EEXIST');
          // Filesystems without hard links: fall back to an exclusive create.
          const h2 = await fs.open(target, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | (fsc.O_NOFOLLOW || 0), 0o644).catch((e2) => {
            if (e2 && e2.code === 'EEXIST') throw new WorkspaceError('File already exists; pass overwrite:true to replace it', 'EEXIST');
            throw e2;
          });
          await h2.writeFile(text, 'utf8');
          await h2.close();
        }
        await fs.unlink(tmp).catch(() => {});
      }
    } catch (e) {
      if (fh) await fh.close().catch(() => {});
      await fs.unlink(tmp).catch(() => {});
      if (e instanceof WorkspaceError) throw e;
      throw new WorkspaceError('Unable to write file', 'EWRITE');
    }
    return { file: formatId(root, segments.join('/'), null), bytes, replaced: !!existing };
  }

  return {
    roots: resolved.map((w) => ({ label: w.label })),
    labels: resolved.map((w) => w.label),
    rootPaths: resolved.map((w) => w.real),
    multi,
    warnings,
    index,
    loadCollection,
    loadEnvironment,
    readJsonSafe: (id) => { const p = parseId(id); return readJsonSafe(p.root, p.rel); },
    writeJsonAtomic,
    formatId,
    parseId,
  };
}

module.exports = { createWorkspaces, WorkspaceError, parseRelativePath, classify, isInside };
