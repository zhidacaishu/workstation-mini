const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig } = require('../src/config');

const STALE_INDEX_DAYS = 90;

/**
 * 索引库放在应用数据目录里，每个资料库一份，文件名取资料库路径的散列。
 *
 * 以前放在资料库根目录（workstation.db）。资料库常放在云盘里，SQLite 的 WAL 文件被
 * 云盘同步搅乱就会损坏；两台电脑共用同一个云盘资料库时还会互相覆盖对方的索引。
 * 索引本来就是可以随时重建的派生数据，没有理由跟着资料库走。
 */
function indexDatabasePath(indexDir, vaultDir) {
  const normalized = path.resolve(vaultDir);
  const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  const hash = crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
  return path.join(indexDir, `${hash}.db`);
}

/** 切换过的资料库会留下索引；很久没用的删掉，需要时会重建。 */
function pruneStaleIndexes(indexDir, keepPath, now = Date.now()) {
  let entries;
  try { entries = fs.readdirSync(indexDir); } catch { return; }
  const keep = path.basename(keepPath);
  for (const name of entries) {
    if (!/^[a-f0-9]{16}\.db$/.test(name) || name === keep) continue;
    const file = path.join(indexDir, name);
    try {
      if (now - fs.statSync(file).mtimeMs < STALE_INDEX_DAYS * 86_400_000) continue;
      for (const suffix of ['', '-wal', '-shm', '-corrupt']) fs.rmSync(file + suffix, { force: true });
    } catch {}
  }
}

const LEGACY_INDEX_IDLE_DAYS = 3;

/**
 * 旧版本把索引放在资料库根目录的 workstation.db。新版本不再用它，留着只是占地方，
 * 资料库在云盘里时还会被反复同步。几天没动过才删：另一台设备如果还在跑旧版本、
 * 正开着这个文件，它会一直更新修改时间，这里就不碰。删掉也没有损失 —— 索引随时能重建。
 */
function removeLegacyVaultIndex(vaultDir, now = Date.now()) {
  const legacy = path.join(vaultDir, 'workstation.db');
  const removed = [];
  try {
    const stats = fs.statSync(legacy);
    if (!stats.isFile() || now - stats.mtimeMs < LEGACY_INDEX_IDLE_DAYS * 86_400_000) return removed;
  } catch {
    return removed;
  }
  for (const suffix of ['', '-wal', '-shm', '-corrupt', '-journal']) {
    try {
      fs.rmSync(legacy + suffix);
      removed.push(path.basename(legacy + suffix));
    } catch {}
  }
  return removed;
}

function createRuntimeConfig(settings, { isProduction = true, windowChrome = 'native', indexDir = '' } = {}) {
  if (!settings.vaultDir) throw new Error('尚未选择资料库目录。');
  return loadConfig({
    ...settings,
    ...(indexDir ? { dbPath: indexDatabasePath(indexDir, settings.vaultDir) } : {}),
    isProduction,
    windowChrome,
    internalToken: crypto.randomBytes(32).toString('hex')
  });
}

module.exports = { createRuntimeConfig, indexDatabasePath, pruneStaleIndexes, removeLegacyVaultIndex, STALE_INDEX_DAYS, LEGACY_INDEX_IDLE_DAYS };
