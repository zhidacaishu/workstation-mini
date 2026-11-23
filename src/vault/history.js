const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { ensureSafeFilePath, toPosix, isSafeRelativePath, isNotePath } = require('./paths');
const { enqueueFile } = require('./note-queue');
const { replaceFile } = require('./atomic');

/**
 * 本机版本历史与草稿。
 *
 * 放在笔记旁边（notes/.workstation-local/），但不进索引、不进 Git，即使没开自动同步。
 *
 *   .workstation-local/
 *     versions/<笔记键>/path.json                       这一组版本属于哪篇笔记
 *     versions/<笔记键>/<时间戳>-<save|delete|abort|conflict|card>-<uuid>.json
 *                                                      保存前、删除笔记前、中止 Git 操作前、
 *                                                      解决同步冲突时没采用的那一边、
 *                                                      删除卡片前的全文
 *     drafts/<uuid>.json                               编辑器自动保存的草稿
 *
 * 版本按笔记分目录，种类和时间写在文件名里：列出历史只需要 readdir，不必把每份
 * 全文都读进来解析。以前所有记录平铺在一个目录里，打开任何一篇笔记的编辑页都要
 * 把全部记录读一遍，记录越多越慢，而且从不清理。
 *
 * 每次保存后只清理这一篇笔记的旧版本：最近 KEEP_RECENT 份全部保留；更早的在
 * KEEP_DAYS 天内每天留最后一份，再早的删除。删除前的那一份是被删笔记唯一的副本：
 * 之后在同一路径新建、反复保存，也不能把它挤掉，所以删除记录一律不清理。
 * 中止 Git 操作前的内容（abort）和解决冲突时没采用的那一边（conflict）同理：
 * 它们是这些改动在应用里唯一的副本，也一律不清理。删卡前的卡组（card）见 pruneVersions。
 */
const DIRECTORY = '.workstation-local';
const KEEP_RECENT = 20;
const KEEP_DAYS = 60;
const DRAFT_KEEP_DAYS = 30;
const DAY_MS = 86_400_000;
// 这几种记录是对应内容在应用里唯一的副本，不参与清理。
const UNPRUNED_REASONS = new Set(['delete', 'abort', 'conflict']);

const UUID = /^[a-f0-9-]{36}$/;
const VERSION_FILE = /^(\d{8}T\d{9}Z)-(save|delete|abort|conflict|card)-([a-f0-9-]{36})\.json$/;
const VERSION_ID = /^([a-f0-9]{16})~(\d{8}T\d{9}Z-(?:save|delete|abort|conflict|card)-[a-f0-9-]{36})$/;

const notFound = () => Object.assign(new Error('恢复记录不存在。'), { status: 404, code: 'ENOENT' });

function noteKey(notePath) {
  return crypto.createHash('sha256').update(toPosix(notePath), 'utf8').digest('hex').slice(0, 16);
}

/** 2026-10-28T10:30:00.123Z → 20261028T103000123Z：可排序，也能放进文件名。 */
function compactStamp(iso) {
  return iso.replace(/[-:.]/g, '');
}

function isoFromStamp(stamp) {
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.${stamp.slice(15, 18)}Z`;
}

function versionId(key, fileName) {
  return `${key}~${fileName.slice(0, -'.json'.length)}`;
}

function validRecordPath(kind, value) {
  if (kind === 'draft' && value === '') return true;
  return typeof value === 'string' && isSafeRelativePath(value) && value.toLowerCase().endsWith('.md');
}

function validRecord(value, id) {
  return value && value.id === id && ['version', 'draft'].includes(value.kind)
    && validRecordPath(value.kind, value.path)
    && typeof value.raw === 'string';
}

async function prepare(root) {
  const ignore = await ensureSafeFilePath(root, DIRECTORY + '/.gitignore', { allowMissing: true, createParents: true });
  try { await fs.writeFile(ignore, '*\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

async function writeJson(root, relative, value) {
  await prepare(root);
  const file = await ensureSafeFilePath(root, relative, { allowMissing: true, createParents: true });
  const temporary = file + '.tmp-' + crypto.randomUUID();
  try {
    // 先 fsync 再改名：只靠 rename 的话，断电后可能留下一个改了名的空文件，
    // 而笔记本身已经写成了新内容，这份旧版本就再也找不回来。
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await ensureSafeFilePath(root, relative, { allowMissing: true });
    await replaceFile(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

// 附件及其它文件不能放进 Markdown 版本列表。按原始字节保存，保留相对路径供找回。
async function saveConflictCopy(root, relative) {
  let source;
  try { source = await ensureSafeFilePath(root, relative); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  await prepare(root);
  const directory = `${DIRECTORY}/git-conflicts/${crypto.randomUUID()}`;
  // 自定义的上级 .gitignore 可能没有排除副本。每个新目录自己忽略全部内容。
  const ignore = await ensureSafeFilePath(root, directory + '/.gitignore', { allowMissing: true, createParents: true });
  await fs.writeFile(ignore, '*\n', { flag: 'wx', mode: 0o600 });
  const copy = `${directory}/files/${relative}`;
  const target = await ensureSafeFilePath(root, copy, { allowMissing: true, createParents: true });
  const handle = await fs.open(target, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(createReadStream(source));
      await handle.sync();
    } finally { await handle.close(); }
  } catch (error) {
    await fs.rm(target, { force: true });
    throw error;
  }
  return copy;
}

async function readJson(root, relative) {
  return JSON.parse(await fs.readFile(await ensureSafeFilePath(root, relative), 'utf8'));
}

/** 目录不存在时返回空表；路径上有符号链接等不安全情况照常抛错。 */
// writeJson 的临时文件：进程在改名前崩溃会留在目录里。超过一天的才清，正在写的不动。
const STALE_TEMPORARY = /\.json\.tmp-[a-f0-9-]{36}$/;
const STALE_TEMPORARY_MS = DAY_MS;

async function removeStaleTemporaries(root, directory, names, now) {
  for (const name of names) {
    if (!STALE_TEMPORARY.test(name)) continue;
    try {
      const file = await ensureSafeFilePath(root, `${directory}/${name}`);
      if (now - (await fs.lstat(file)).mtimeMs > STALE_TEMPORARY_MS) await fs.rm(file, { force: true });
    } catch { /* 清理是顺手的事 */ }
  }
}

async function listDirectory(root, relative) {
  try {
    await ensureSafeFilePath(root, relative + '/.probe', { allowMissing: true });
    return await fs.readdir(path.join(root, ...relative.split('/')));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

// ---------- 旧版平铺记录的迁移 ----------

const migrations = new Map();

/**
 * 旧版本把所有记录平铺成 .workstation-local/<uuid>.json。第一次访问历史时搬进新布局：
 * 先写新文件再删旧文件，中途崩溃下次会接着搬（同一个 uuid 写到同一个新文件名）。
 * 读不出来的旧文件原样留着，不因为一条坏记录挡住其余的。
 */
async function migrateLegacy(root) {
  for (const entry of await listDirectory(root, DIRECTORY)) {
    if (!entry.endsWith('.json') || !UUID.test(entry.slice(0, -5))) continue;
    const id = entry.slice(0, -5);
    let record;
    try {
      record = await readJson(root, `${DIRECTORY}/${entry}`);
      if (!validRecord(record, id)) continue;
      // 时间统一成 toISOString 的写法，新文件名才解析得回来；缺时间或写法不认识的，
      // 退回旧文件的修改时间，而不是让整个迁移失败、历史页和草稿自动保存都跟着坏掉。
      let time = Date.parse(record.at);
      if (!Number.isFinite(time)) time = (await fs.stat(path.join(root, DIRECTORY, entry))).mtimeMs;
      record = { ...record, at: new Date(time).toISOString() };
      if (record.kind === 'draft') {
        await writeJson(root, `${DIRECTORY}/drafts/${id}.json`, record);
      } else {
        await storeVersion(root, { ...record, reason: record.reason === 'delete' ? 'delete' : 'save' }, id, { prune: false });
      }
      await fs.rm(await ensureSafeFilePath(root, `${DIRECTORY}/${entry}`), { force: true });
    } catch { continue; }
  }
}

function migrated(root) {
  const key = path.resolve(root);
  if (!migrations.has(key)) {
    const run = migrateLegacy(root).catch(error => {
      migrations.delete(key);
      throw error;
    });
    migrations.set(key, run);
  }
  return migrations.get(key);
}

// ---------- 版本 ----------

async function storeVersion(root, { path: notePath, raw, reason, at }, uuid, { prune = true } = {}) {
  const key = noteKey(notePath);
  const fileName = `${compactStamp(at)}-${reason}-${uuid}.json`;
  const id = versionId(key, fileName);
  const record = { id, kind: 'version', path: toPosix(notePath), raw, reason, at };
  const directory = `${DIRECTORY}/versions/${key}`;
  await writeJson(root, `${directory}/path.json`, { path: record.path });
  await writeJson(root, `${directory}/${fileName}`, record);
  // 版本已经存好；清理失败不能让调用方（保存笔记、删卡）跟着失败。
  if (prune) {
    try {
      await pruneVersions(root, key);
    } catch (error) {
      console.warn(`[history] 清理旧版本失败，下次保存时重试：${error.message}`);
    }
  }
  return record;
}

/** 先按时间新到旧排；同一时刻的按 uuid 排，保证结果确定。 */
function newestFirst(left, right) {
  return right.at.localeCompare(left.at) || right.id.localeCompare(left.id);
}

// 「每天留一份」按用户所在时区的日期算：东八区凌晨的保存不该算进前一天。
function localDay(iso) {
  const date = new Date(iso);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function versionEntries(key, names) {
  return names.flatMap(name => {
    const match = VERSION_FILE.exec(name);
    if (!match) return [];
    const at = isoFromStamp(match[1]);
    return [{ name, id: versionId(key, name), at, reason: match[2], day: localDay(at) }];
  });
}

async function pruneVersions(root, key, now = Date.now()) {
  const directory = `${DIRECTORY}/versions/${key}`;
  const names = await listDirectory(root, directory);
  await removeStaleTemporaries(root, directory, names, now);
  const entries = versionEntries(key, names).sort(newestFirst);
  // 删卡前的整份卡组：KEEP_DAYS 天内全留，更早的每天只留当天最早的一份。
  // 当天稍后新增或编辑的卡可能只存在于后续快照中。
  const earliestCardOfDay = new Map();
  for (const entry of entries) if (entry.reason === 'card') earliestCardOfDay.set(entry.day, entry.name);
  // 「最近 KEEP_RECENT 份」只数普通保存：删卡快照和不清理的记录各有规则，不挤占名额。
  // 最近的几份也算作当天留下的那一份，同一天不会再多留一份更早的。
  const keptDays = new Set();
  let saves = 0;
  for (const entry of entries) {
    if (UNPRUNED_REASONS.has(entry.reason)) continue;
    const age = now - Date.parse(entry.at);
    if (entry.reason === 'card') {
      if (age <= KEEP_DAYS * DAY_MS || earliestCardOfDay.get(entry.day) === entry.name) continue;
    } else {
      saves += 1;
      if (saves <= KEEP_RECENT) {
        keptDays.add(entry.day);
        continue;
      }
      if (age <= KEEP_DAYS * DAY_MS && !keptDays.has(entry.day)) {
        keptDays.add(entry.day);
        continue;
      }
    }
    // 清理只是省空间：某一份删不掉（Windows 上被杀毒软件占着、别处已经删了）就留到下次。
    try {
      await fs.rm(await ensureSafeFilePath(root, `${directory}/${entry.name}`), { force: true });
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`[history] 清理旧版本失败，下次保存时重试：${error.message}`);
    }
  }
}

const VERSION_REASONS = new Set(['save', 'delete', 'abort', 'conflict', 'card']);

async function saveVersion(root, notePath, raw, reason) {
  // 原因写进文件名；不认识的写法列不出来，等于白存。
  if (!VERSION_REASONS.has(reason)) reason = 'save';
  try {
    return await storeVersion(root, { path: notePath, raw, reason, at: new Date().toISOString() }, crypto.randomUUID());
  } catch (cause) {
    throw Object.assign(new Error('本机历史未能保存，请检查磁盘后重试。', { cause }), { code: 'HISTORY_WRITE_FAILED' });
  }
}

async function versionsOf(root, key) {
  const directory = `${DIRECTORY}/versions/${key}`;
  const names = await listDirectory(root, directory);
  if (!names.includes('path.json')) return [];
  let notePath;
  try { notePath = (await readJson(root, `${directory}/path.json`)).path; } catch { return []; }
  if (!isSafeRelativePath(notePath)) return [];
  return versionEntries(key, names).map(entry => ({ id: entry.id, kind: 'version', path: notePath, reason: entry.reason, at: entry.at }));
}

// ---------- 草稿 ----------

async function draftsOf(root) {
  const records = [];
  for (const entry of await listDirectory(root, `${DIRECTORY}/drafts`)) {
    const id = entry.slice(0, -5);
    if (!entry.endsWith('.json') || !UUID.test(id)) continue;
    try {
      const record = await readJson(root, `${DIRECTORY}/drafts/${entry}`);
      if (validRecord(record, id) && record.kind === 'draft') {
        records.push({ id, kind: 'draft', path: record.path, at: record.at, sequence: record.sequence });
      }
    } catch { /* 一份坏草稿不该挡住其余记录。 */ }
  }
  return records;
}

async function readDraft(root, id) {
  const record = await readJson(root, `${DIRECTORY}/drafts/${id}.json`);
  if (!validRecord(record, id) || record.kind !== 'draft') throw new Error('恢复记录格式不合法。');
  return record;
}

async function saveDraft(root, id, input) {
  if (!UUID.test(String(id))) throw notFound();
  if (!validRecordPath('draft', input.path)
      || typeof input.raw !== 'string' || !Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw Object.assign(new Error('草稿路径或版本不合法。'), { status: 400 });
  }
  await migrated(root);
  const relative = `${DIRECTORY}/drafts/${id}.json`;
  return enqueueFile(root, relative, async () => {
    let old;
    try { old = await readDraft(root, id); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (old && old.sequence >= input.sequence) {
      throw Object.assign(new Error('草稿版本已更新。'), { status: 409 });
    }
    const record = { id, kind: 'draft', path: isNotePath(input.path) ? toPosix(input.path) : '', raw: input.raw,
      baseHash: String(input.baseHash || ''), sequence: input.sequence, at: new Date().toISOString() };
    if (!record.path && typeof input.folder === 'string' && isNotePath(input.folder + '/x.md')) {
      record.folder = toPosix(input.folder);
    }
    await writeJson(root, relative, record);
    return { id, sequence: record.sequence };
  });
}

async function removeDraft(root, id, sequence) {
  if (!UUID.test(String(id))) throw notFound();
  await migrated(root);
  const relative = `${DIRECTORY}/drafts/${id}.json`;
  return enqueueFile(root, relative, async () => {
    let old;
    try { old = await readDraft(root, id); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (old.sequence !== sequence) {
      throw Object.assign(new Error('草稿已经更新，未删除。'), { status: 409 });
    }
    await fs.rm(await ensureSafeFilePath(root, relative));
  });
}

/**
 * 清掉很久没动过的草稿。放弃编辑留下的草稿没有别的出口，不清就只增不减，
 * 而每次打开编辑页都要把全部草稿读一遍。
 */
async function pruneDrafts(root, { maxAgeDays = DRAFT_KEEP_DAYS, now = Date.now() } = {}) {
  await migrated(root);
  let removed = 0;
  const names = await listDirectory(root, `${DIRECTORY}/drafts`);
  await removeStaleTemporaries(root, `${DIRECTORY}/drafts`, names, now);
  for (const entry of names) {
    const id = entry.slice(0, -5);
    if (!entry.endsWith('.json') || !UUID.test(id)) continue;
    const relative = `${DIRECTORY}/drafts/${entry}`;
    try {
      const stat = await fs.stat(await ensureSafeFilePath(root, relative));
      if (now - stat.mtimeMs <= maxAgeDays * DAY_MS) continue;
      await enqueueFile(root, relative, async () => {
        // 排队期间可能刚被自动保存更新过：按当前的修改时间再判一次。
        const latest = await fs.stat(await ensureSafeFilePath(root, relative));
        if (now - latest.mtimeMs <= maxAgeDays * DAY_MS) return;
        await fs.rm(await ensureSafeFilePath(root, relative), { force: true });
        removed += 1;
      });
    } catch { /* 清理是顺手的事，一份草稿出错不影响其余。 */ }
  }
  return removed;
}

// ---------- 查询 ----------

/**
 * 列出记录（不含全文）。给了 notePath 只读那一篇笔记的版本目录；不给就列全部。
 * 要看全文用 getRecord。
 */
async function listRecords(root, notePath = '') {
  await migrated(root);
  const versions = notePath
    ? await versionsOf(root, noteKey(notePath))
    : (await Promise.all((await listDirectory(root, `${DIRECTORY}/versions`))
        .filter(name => /^[a-f0-9]{16}$/.test(name))
        .map(key => versionsOf(root, key)))).flat();
  const drafts = (await draftsOf(root)).filter(record => !notePath || record.path === toPosix(notePath));
  return [...versions.filter(record => !notePath || record.path === toPosix(notePath)), ...drafts].sort(newestFirst);
}

async function getRecord(root, id) {
  const value = String(id);
  await migrated(root);
  const version = VERSION_ID.exec(value);
  if (version) {
    const record = await readJson(root, `${DIRECTORY}/versions/${version[1]}/${version[2]}.json`);
    if (!validRecord(record, value) || record.kind !== 'version') throw new Error('恢复记录格式不合法。');
    return record;
  }
  if (!UUID.test(value)) throw notFound();
  try {
    return await readDraft(root, value);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // 迁移前的链接只带 uuid：在版本目录里按文件名找一遍。
  for (const key of await listDirectory(root, `${DIRECTORY}/versions`)) {
    if (!/^[a-f0-9]{16}$/.test(key)) continue;
    const name = (await listDirectory(root, `${DIRECTORY}/versions/${key}`)).find(entry => entry.endsWith(`-${value}.json`));
    if (name) return getRecord(root, versionId(key, name));
  }
  throw notFound();
}

async function listDeckRecords(vaultDir, file = '') {
  return (await listRecords(vaultDir, file)).filter(record => record.path.startsWith('cards/'));
}

module.exports = {
  saveConflictCopy, listDeckRecords,
  DIRECTORY, KEEP_RECENT, KEEP_DAYS,
  DRAFT_KEEP_DAYS,
  getRecord, listRecords, saveVersion, saveDraft, removeDraft, pruneVersions, pruneDrafts, noteKey
};
