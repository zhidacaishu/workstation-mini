const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { listNotes } = require('./vault/note');
const { listRecords, listDeckRecords } = require('./vault/history');
const { readEvents, isValidEvent, isRegularFile } = require('./review');
const { loadAllCards } = require('./cards');

const run = promisify(execFile);
const BROKEN_LINK_LIMIT = 200;

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

async function gitReport(vaultDir, timeoutMs = 1500) {
  const base = { isRepository: false, branch: '', upstream: '', dirty: false, changedPaths: [], ahead: 0, behind: 0, recoveryRequired: null };
  const git = async args => (await run('git', ['-C', vaultDir, ...args], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout;
  try {
    // 和同步、上手指南同一个判断：资料库自己得是工作树的根。放在别的仓库子目录里时，
    // Git 会认父仓库，报出来的分支和未提交文件都是别人的。
    const [root, vault] = await Promise.all([
      fs.realpath((await git(['rev-parse', '--show-toplevel'])).trim()),
      fs.realpath(vaultDir)
    ]);
    if (path.relative(root, vault) !== '') return base;
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
    // 「这里不是 Git 仓库」和「没装 Git」都是明确的答案，不算探测失败：
    // 没开同步的人看到「状态未知」只会以为哪里坏了。
    if (error.code === 'ENOENT') base.gitMissing = true;
    else if (/not a git repository/i.test(String(error.stderr || ''))) base.isRepository = false;
    else base.error = error.code === 'ETIMEDOUT' ? 'git probe timeout' : 'git probe unavailable';
  }
  return base;
}

async function reviewReport(vaultDir) {
  const dir = path.join(vaultDir, 'reviews');
  let files = 0; let malformedLines = 0; let duplicateEventIds = 0; let records = 0;
  const ids = new Set();
  try {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!entry.name.endsWith('.jsonl') || !(await isRegularFile(entry, path.join(dir, entry.name)))) continue;
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
  const deckFailures = [];
  let cards;
  try {
    cards = await loadAllCards(vaultDir, { onError: failure => deckFailures.push(failure.path) });
  } catch {
    // 整个目录未能列完，无法确定哪些卡组或卡片缺失。
  }
  let orphanedCards = null;
  if (cards && !deckFailures.length) {
    const events = await readEvents(vaultDir).catch(() => null);
    if (events) {
      const cardIds = new Set(cards.flatMap(card => [card.id, card.legacyId]));
      orphanedCards = new Set(events.filter(event => !cardIds.has(event.cardId)).map(event => event.cardId)).size;
    }
  }
  return { files, records, malformedLines, duplicateEventIds, orphanedCards, deckFailures, deckScanFailed: !cards };
}

async function createHealthReport({ config, db, indexer, sync, now = () => new Date() }) {
  const vaultExists = await exists(config.vaultDir);
  const notesDirExists = await exists(config.notesDir);
  // 某个子文件夹读不了时照样出报告，把它列出来，而不是让整页报错。
  const unreadableFolders = [];
  const noteFiles = notesDirExists
    ? await listNotes(config.notesDir, { onUnreadable: directory => unreadableFolders.push(directory) })
    : [];
  const index = indexer?.getStatus?.() || {};
  const statErrors = [];
  function readStat(statistic, read) {
    try { return read(); } catch {
      // Keep other diagnostics available; raw database errors may contain private data.
      statErrors.push({ statistic, code: 'database-read-failed', reason: '索引统计读取失败，结果未知。' });
      return null;
    }
  }
  const indexedNotes = readStat('indexedNotes', () => db.countNotes());
  const brokenCount = readStat('brokenCount', () => db.raw.prepare("SELECT count(*) AS c FROM links WHERE to_path = ''").get().c);
  // 断链逐条列出来（来源笔记 + 写的目标），最多 BROKEN_LINK_LIMIT 条；只有路径、标题和链接目标，没有正文。
  // 同名多篇造成的未解析双链单独列在 ambiguousTargets，保持 broken 条目结构简洁且不为同名双链建议新建第三篇。
  const ambiguousBasenames = new Set();
  if (brokenCount) {
    const seen = new Set();
    const notePaths = readStat('notePaths', () => db.listPaths()) || [];
    for (const notePath of notePaths) {
      const normalized = String(notePath || '').replace(/\\/g, '/');
      const name = normalized.slice(normalized.lastIndexOf('/') + 1).replace(/\.md$/i, '');
      if (seen.has(name)) ambiguousBasenames.add(name);
      else seen.add(name);
    }
  }
  const brokenLinks = brokenCount ? readStat('brokenLinks', () => db.raw.prepare(
    `SELECT l.from_path AS path, l.to_target AS target, n.title_raw AS title
       FROM links l LEFT JOIN notes n ON n.path = l.from_path
      WHERE l.to_path = '' ORDER BY l.from_path, l.to_target LIMIT ?`
  ).all(BROKEN_LINK_LIMIT)) || [] : [];
  const ambiguousTargets = [...new Set(brokenLinks
    .map(item => String(item.target || ''))
    .filter(target => {
      const clean = target.replace(/\\/g, '/').replace(/\.md$/i, '');
      return !clean.includes('/') && ambiguousBasenames.has(clean);
    }))];
  let records = [];
  try { records = await listRecords(config.notesDir); } catch {}
  const decks = await listDeckRecords(config.vaultDir).catch(() => []);
  const historyCount = records.length + decks.length;
  const git = await gitReport(config.vaultDir);
  const reviews = await reviewReport(config.vaultDir);
  const draftCount = records.filter(record => record.kind === 'draft').length;
  const deletedNoteHistoryCount = records.filter(record => record.kind === 'version' && record.reason === 'delete').length;
  const syncRecovery = sync && sync.getStatus ? sync.getStatus().recovery || null : null;
  return {
    generatedAt: now().toISOString(),
    vault: { exists: vaultExists, notesDirExists, noteFiles: noteFiles.length, unreadableFolders, indexedNotes, indexLag: indexedNotes === null ? null : noteFiles.length - indexedNotes, indexRebuildable: true },
    index: { statErrors, phase: index.phase || 'unknown', generation: index.generation || 0, done: index.done || 0, total: index.total || 0, failureTotal: index.failureTotal || 0, failures: (index.failures || []).map(item => ({ path: item.path, code: item.code, reason: item.reason, retryable: item.retryable })), failuresTruncated: Boolean(index.failuresTruncated), fatal: index.fatal || null },
    links: { brokenCount, broken: brokenLinks, brokenTruncated: brokenCount != null && brokenCount > brokenLinks.length, ambiguousTargets },
    sync: { enabled: Boolean(config.syncEnabled) },
    reviews,
    drafts: { count: draftCount, deletedNoteHistoryCount, historyCount },
    git: Object.assign({}, git, { changedPaths: git.changedPaths || [] }),
    recovery: { markdownSource: true, indexRebuildable: true, historyAvailable: historyCount > 0, safeToRebuildIndex: !index.fatal || index.fatal.code === 'database-corrupt', syncRecovery }
  };
}

module.exports = { createHealthReport, gitReport, reviewReport };
