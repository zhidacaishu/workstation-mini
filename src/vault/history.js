const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { ensureSafeFilePath, toAbsolute, toPosix, isSafeRelativePath } = require('./paths');
const { enqueueFile } = require('./note-queue');
const { replaceFile } = require('./atomic');

// Kept next to notes, but hidden from indexing and excluded from Git even when
// automatic sync is disabled. Each record is independently readable JSON.
const DIRECTORY = '.workstation-local';
const ID = /^[a-f0-9-]{36}$/;
function recordPath(id) {
  if (!ID.test(String(id))) throw Object.assign(new Error('恢复记录不存在。'), { status: 404 });
  return DIRECTORY + '/' + id + '.json';
}
async function prepare(root) {
  const ignore = await ensureSafeFilePath(root, DIRECTORY + '/.gitignore', { allowMissing: true, createParents: true });
  try { await fs.writeFile(ignore, '*\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
async function getRecord(root, id) {
  const file = await ensureSafeFilePath(root, recordPath(id));
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  if (value.id !== id || !['version', 'draft'].includes(value.kind)
      || !isSafeRelativePath(value.path) || !value.path.toLowerCase().endsWith('.md')
      || typeof value.raw !== 'string') throw new Error('恢复记录格式不合法。');
  return value;
}
async function putRecord(root, record) {
  await prepare(root);
  const file = await ensureSafeFilePath(root, recordPath(record.id), { allowMissing: true });
  const temporary = file + '.tmp-' + crypto.randomUUID();
  try {
    await fs.writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    await ensureSafeFilePath(root, recordPath(record.id), { allowMissing: true });
    await replaceFile(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}
async function saveVersion(root, notePath, raw, reason) {
  const record = { id: crypto.randomUUID(), kind: 'version', path: toPosix(notePath), raw, reason, at: new Date().toISOString() };
  await putRecord(root, record);
  return record;
}
async function listRecords(root, notePath = '') {
  let entries;
  try {
    // Validate the storage directory before enumeration.
    await ensureSafeFilePath(root, DIRECTORY + '/.gitignore');
    entries = await fs.readdir(path.join(root, DIRECTORY));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json') || !ID.test(entry.slice(0, -5))) continue;
    try {
      const record = await getRecord(root, entry.slice(0, -5));
      if (!notePath || record.path === toPosix(notePath)) records.push(record);
    } catch { /* A damaged recovery record must not hide the remaining versions. */ }
  }
  return records.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
}
async function saveDraft(root, id, input) {
  const relative = recordPath(id);
  if (!isSafeRelativePath(input.path) || !input.path.toLowerCase().endsWith('.md')
      || typeof input.raw !== 'string' || !Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw Object.assign(new Error('草稿路径或版本不合法。'), { status: 400 });
  }
  return enqueueFile(root, relative, async () => {
    let old;
    try { old = await getRecord(root, id); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (old && (old.kind !== 'draft' || old.sequence >= input.sequence)) {
      throw Object.assign(new Error('草稿版本已更新。'), { status: 409 });
    }
    const record = { id, kind: 'draft', path: toPosix(input.path), raw: input.raw,
      baseHash: String(input.baseHash || ''), sequence: input.sequence, at: new Date().toISOString() };
    await putRecord(root, record);
    return { id, sequence: record.sequence };
  });
}
async function removeDraft(root, id, sequence) {
  return enqueueFile(root, recordPath(id), async () => {
    let old;
    try { old = await getRecord(root, id); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (old.kind !== 'draft' || old.sequence !== sequence) {
      throw Object.assign(new Error('草稿已经更新，未删除。'), { status: 409 });
    }
    await fs.rm(await ensureSafeFilePath(root, recordPath(id)));
  });
}
module.exports = { DIRECTORY, getRecord, listRecords, saveVersion, saveDraft, removeDraft };
