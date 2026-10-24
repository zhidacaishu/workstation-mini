const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { replaceFile } = require('../vault/atomic');

const JOURNAL_VERSION = 1;
const OWNER_FILE = 'owner.json';
const CANDIDATE_DIR = 'candidate';
const MODES = new Set(['restore', 'repair-blobs']);
const PHASES = new Set(['prepared', 'candidate-present', 'renamed']);
const SESSION_PATTERN = /^[A-Za-z0-9-]{1,100}$/;

function ownedRootFor(destinationPath, sessionId) {
  return path.join(path.dirname(destinationPath), `.workstation-recovery-${sessionId}`);
}

function journalRecord(value) {
  if (!value || value.version !== JOURNAL_VERSION
    || !SESSION_PATTERN.test(value.sessionId)
    || !MODES.has(value.mode)
    || !PHASES.has(value.phase)
    || typeof value.stagingRoot !== 'string'
    || typeof value.destinationPath !== 'string'
    || !path.isAbsolute(value.stagingRoot)
    || !path.isAbsolute(value.destinationPath)) return null;

  const stagingRoot = path.resolve(value.stagingRoot);
  const destinationPath = path.resolve(value.destinationPath);
  if (stagingRoot !== ownedRootFor(destinationPath, value.sessionId)) return null;

  return {
    version: JOURNAL_VERSION,
    sessionId: value.sessionId,
    mode: value.mode,
    stagingRoot,
    destinationPath,
    phase: value.phase,
    createdAt: String(value.createdAt || ''),
    updatedAt: String(value.updatedAt || ''),
    ...(value.lastError ? {
      lastError: {
        stage: String(value.lastError.stage || ''),
        code: String(value.lastError.code || '')
      }
    } : {})
  };
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function createRecoveryJournal({ journalPath, now = () => new Date().toISOString() } = {}) {
  if (!journalPath) throw new Error('恢复 journal 缺少存储路径。');

  async function write(record) {
    const safe = journalRecord({
      version: JOURNAL_VERSION,
      sessionId: record.sessionId,
      mode: record.mode,
      stagingRoot: record.stagingRoot,
      destinationPath: record.destinationPath,
      phase: record.phase,
      createdAt: record.createdAt || now(),
      updatedAt: now(),
      lastError: record.lastError
    });
    if (!safe) throw new Error('恢复 journal 记录不合法。');

    await fsp.mkdir(path.dirname(journalPath), { recursive: true });
    const temporary = `${journalPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      await fsp.writeFile(temporary, `${JSON.stringify(safe, null, 2)}\n`, { flag: 'wx' });
      await replaceFile(temporary, journalPath);
    } finally {
      await fsp.rm(temporary, { force: true });
    }
    return safe;
  }

  async function read() {
    return journalRecord(await readJson(journalPath));
  }

  async function clear() {
    await fsp.rm(journalPath, { force: true });
  }

  async function ownerOf(stagingRoot) {
    let root;
    try {
      root = await fsp.lstat(stagingRoot);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (!root.isDirectory() || root.isSymbolicLink()) return null;

    const value = await readJson(path.join(stagingRoot, OWNER_FILE));
    if (!value || value.version !== JOURNAL_VERSION
      || !SESSION_PATTERN.test(value.sessionId)
      || typeof value.destinationPath !== 'string'
      || !path.isAbsolute(value.destinationPath)) return null;
    const destinationPath = path.resolve(value.destinationPath);
    if (path.resolve(stagingRoot) !== ownedRootFor(destinationPath, value.sessionId)) return null;
    return { version: JOURNAL_VERSION, sessionId: value.sessionId, destinationPath };
  }

  async function inspect() {
    const record = await read();
    if (!record) return null;
    const owner = await ownerOf(record.stagingRoot);
    const destinationExists = await fsp.lstat(record.destinationPath).then(() => true, () => false);
    const candidatePath = path.join(record.stagingRoot, CANDIDATE_DIR);
    const candidateExists = await fsp.lstat(candidatePath).then(() => true, () => false);
    const stagingExists = await fsp.lstat(record.stagingRoot).then(() => true, () => false);
    const staleAfterRename = destinationExists && !candidateExists && !stagingExists;
    return {
      record,
      owned: Boolean(owner && owner.sessionId === record.sessionId
        && owner.destinationPath === record.destinationPath),
      candidateExists,
      destinationExists,
      stagingExists,
      staleAfterRename
    };
  }

  async function discardOwnedStaging() {
    const residue = await inspect();
    if (!residue) return { ok: true, absent: true };
    if (residue.staleAfterRename) {
      await clear();
      return { ok: true, destinationPreserved: true };
    }
    if (!residue.owned) throw new Error('恢复残留的所有权标记不匹配，拒绝自动清理。');
    if (residue.destinationExists && !residue.candidateExists) {
      await fsp.rm(residue.record.stagingRoot, { recursive: true, force: true });
      await clear();
      return { ok: true, destinationPreserved: true, removed: true };
    }
    await fsp.rm(residue.record.stagingRoot, { recursive: true, force: true });
    await clear();
    return { ok: true, removed: true };
  }

  return { write, read, inspect, clear, ownerOf, discardOwnedStaging, journalPath };
}

async function createOwnedStaging({ destinationParent, destinationPath, sessionId }) {
  if (!SESSION_PATTERN.test(sessionId)) throw new Error('恢复 sessionId 不合法。');
  const parent = path.resolve(destinationParent);
  const destination = path.resolve(destinationPath);
  if (path.dirname(destination) !== parent) throw new Error('恢复目标必须是所选父目录的直接子目录。');
  const root = ownedRootFor(destination, sessionId);
  const candidatePath = path.join(root, CANDIDATE_DIR);
  await fsp.mkdir(root, { recursive: false });
  try {
    await fsp.writeFile(path.join(root, OWNER_FILE), `${JSON.stringify({
      version: JOURNAL_VERSION,
      sessionId,
      destinationPath: destination
    }, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    await fsp.rm(root, { recursive: true, force: true });
    throw error;
  }
  return { stagingRoot: root, candidatePath };
}

module.exports = {
  createRecoveryJournal,
  createOwnedStaging,
  JOURNAL_VERSION,
  OWNER_FILE,
  CANDIDATE_DIR
};
