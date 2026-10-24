const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { listNotes } = require('./vault/note');
const { listRecords } = require('./vault/history');
const { readEvents, isValidEvent } = require('./review');
const { loadAllCards } = require('./cards');

const run = promisify(execFile);

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

async function gitReport(vaultDir, timeoutMs = 1500) {
  const base = { isRepository: false, branch: '', upstream: '', dirty: false, changedPaths: [], ahead: 0, behind: 0, recoveryRequired: null };
  const git = async args => (await run('git', ['-C', vaultDir, ...args], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout;
  try {
    if ((await git(['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') return base;
    base.isRepository = true;
    base.branch = (await git(['branch', '--show-current']).catch(() => '')).trim();
    base.upstream = (await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim();
    const entries = (await git(['status', '--porcelain=v1', '-z'])).split('\0');
    const changedPaths = [];
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (!entry) continue;
      changedPaths.push(entry.slice(3));
      if (/[RC]/.test(entry.slice(0, 2))) i += 1;
    }
    base.changedPaths = changedPaths.slice(0, 100);
    base.dirty = base.changedPaths.length > 0;
    if (base.upstream) {
      const counts = await git(['rev-list', '--left-right', '--count', 'HEAD...' + base.upstream]);
      const values = counts.trim().split(/\s+/).map(Number);
      base.ahead = Number.isFinite(values[0]) ? values[0] : 0;
      base.behind = Number.isFinite(values[1]) ? values[1] : 0;
    }
    const markers = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];
    const gitDir = (await git(['rev-parse', '--git-dir'])).trim();
    const absoluteGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(vaultDir, gitDir);
    const found = [];
    for (const marker of markers) if (await exists(path.join(absoluteGitDir, marker))) found.push(marker);
    let unmerged = 0;
    try { unmerged = (await git(['ls-files', '-u'])).split(/\r?\n/).filter(Boolean).length; } catch {}
    base.recoveryRequired = found.length || unmerged ? { markers: found, unmerged } : null;
  } catch (error) {
    base.error = error.code === 'ETIMEDOUT' ? 'git probe timeout' : 'git probe unavailable';
  }
  return base;
}

async function reviewReport(vaultDir) {
  const dir = path.join(vaultDir, 'reviews');
  let files = 0; let malformedLines = 0; let duplicateEventIds = 0; let records = 0;
  const ids = new Set();
  try {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      files += 1;
      const lines = (await fs.readFile(path.join(dir, entry.name), 'utf8')).split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const value = JSON.parse(line);
          if (!isValidEvent(value)) { malformedLines += 1; continue; }
          records += 1;
          if (value.event_id) { if (ids.has(value.event_id)) duplicateEventIds += 1; ids.add(value.event_id); }
        } catch { malformedLines += 1; }
      }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let orphanedCards = 0;
  try {
    const events = await readEvents(vaultDir);
    // Review event IDs are derived from each card heading, not only filenames.
    const cards = await loadAllCards(vaultDir);
    const cardIds = new Set(cards.flatMap(card => [card.id, card.legacyId]));
    orphanedCards = new Set(events.filter(event => !cardIds.has(event.cardId)).map(event => event.cardId)).size;
  } catch {}
  return { files, records, malformedLines, duplicateEventIds, orphanedCards };
}

async function createHealthReport({ config, db, indexer, sync, now = () => new Date() }) {
  const vaultExists = await exists(config.vaultDir);
  const notesDirExists = await exists(config.notesDir);
  const noteFiles = notesDirExists ? await listNotes(config.notesDir) : [];
  const indexedNotes = Number(db && db.countNotes ? db.countNotes() : 0);
  const index = Object.assign({}, indexer && indexer.getStatus ? indexer.getStatus() : {}, { notes: indexedNotes });
  let brokenCount = 0;
  try { brokenCount = Number(db.raw.prepare("SELECT count(*) AS c FROM links WHERE to_path = ''").get().c || 0); } catch {}
  let records = [];
  try { records = await listRecords(config.notesDir); } catch {}
  const git = await gitReport(config.vaultDir);
  const reviews = await reviewReport(config.vaultDir);
  const draftCount = records.filter(record => record.kind === 'draft').length;
  const deletedNoteHistoryCount = records.filter(record => record.kind === 'version' && record.reason === 'delete').length;
  const syncRecovery = sync && sync.getStatus ? sync.getStatus().recovery || null : null;
  return {
    generatedAt: now().toISOString(),
    vault: { exists: vaultExists, notesDirExists, noteFiles: noteFiles.length, indexedNotes, indexLag: noteFiles.length - indexedNotes, indexRebuildable: true },
    index: { phase: index.phase || 'unknown', generation: index.generation || 0, done: index.done || 0, total: index.total || 0, failureTotal: index.failureTotal || 0, failures: (index.failures || []).map(item => ({ path: item.path, code: item.code, reason: item.reason, retryable: item.retryable })), failuresTruncated: Boolean(index.failuresTruncated), fatal: index.fatal || null },
    links: { brokenCount },
    reviews,
    drafts: { count: draftCount, deletedNoteHistoryCount },
    git: Object.assign({}, git, { changedPaths: git.changedPaths || [] }),
    recovery: { markdownSource: true, indexRebuildable: true, historyAvailable: records.length > 0, safeToRebuildIndex: !index.fatal || index.fatal.code === 'database-corrupt', syncRecovery }
  };
}

module.exports = { createHealthReport, gitReport, reviewReport };
