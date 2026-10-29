const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { replaceFileSync } = require('../src/vault/atomic');

const SCHEMA_VERSION = 5;
const PLAIN_FIELDS = ['vaultDir', 'device', 'readOnly', 'syncEnabled', 'syncIntervalMinutes', 'launchAtLogin', 'theme'];
// 外观：跟随系统、固定浅色或固定深色。旧版本没有这个字段，读到时按跟随系统处理。
const THEMES = Object.freeze(['system', 'light', 'dark']);
const DEFAULT_SETTINGS = Object.freeze({ schemaVersion: SCHEMA_VERSION, vaultDir: '', device: '', readOnly: false, syncEnabled: false, syncIntervalMinutes: 15, launchAtLogin: false, theme: 'system' });

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = filePath + '.tmp-' + process.pid + '-' + crypto.randomUUID();
  try {
    // 先 fsync 再换名：断电时不会留下一个换了名的空设置文件。
    const descriptor = fs.openSync(temporary, 'wx');
    try { fs.writeFileSync(descriptor, content, 'utf8'); try { fs.fsyncSync(descriptor); } catch {} }
    finally { fs.closeSync(descriptor); }
    replaceFileSync(temporary, filePath);
  } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
}
function normalizeSettings(value = {}) {
  const plain = Object.fromEntries(PLAIN_FIELDS.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]]));
  const settings = { ...DEFAULT_SETTINGS, ...plain, schemaVersion: SCHEMA_VERSION };
  const interval = Number(settings.syncIntervalMinutes);
  settings.syncIntervalMinutes = Number.isFinite(interval) ? Math.min(Math.max(Math.trunc(interval), 1), 1440) : 15;
  settings.readOnly = Boolean(settings.readOnly); settings.syncEnabled = Boolean(settings.syncEnabled); settings.launchAtLogin = Boolean(settings.launchAtLogin);
  for (const key of ['vaultDir', 'device']) settings[key] = typeof settings[key] === 'string' ? settings[key].trim() : '';
  settings.theme = THEMES.includes(settings.theme) ? settings.theme : 'system';
  return settings;
}
function createConfigStore({ userDataPath }) {
  const directory = path.join(userDataPath, 'workstation-data');
  const filePath = path.join(directory, 'settings.json');
  const backupPath = path.join(directory, 'settings.previous.json');
  function parseSettings(targetPath) {
    const parsed = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    if (Number(parsed.schemaVersion || 0) > SCHEMA_VERSION) { const error = new Error('设置来自更新版本的 Workstation Mini，请升级应用后再打开。'); error.code = 'SETTINGS_TOO_NEW'; throw error; }
    const migrated = Number(parsed.schemaVersion || 0) < 2 && !Object.hasOwn(parsed, 'syncEnabled')
      ? { ...parsed, syncEnabled: true } : parsed;
    return normalizeSettings(migrated);
  }
  // 上一次 load 遇到的问题，交给主进程决定要不要提示用户：
  // { kind: 'backup', corruptPath } 用了备份；{ kind: 'reset', corruptPath } 两份都坏，按首次启动处理。
  let lastLoadIssue = null;
  /** 坏掉的设置文件改名留存，方便事后查看，也不会在下一次写入时被当成「上一版」备份。 */
  function quarantine(targetPath) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const corruptPath = targetPath.replace(/\.json$/, `.corrupt-${stamp}.json`);
    try { fs.renameSync(targetPath, corruptPath); return corruptPath; } catch { return targetPath; }
  }
  function load() {
    lastLoadIssue = null;
    if (!fs.existsSync(filePath)) return normalizeSettings();
    try { return parseSettings(filePath); } catch (error) {
      if (error.code === 'SETTINGS_TOO_NEW') throw error;
      const corruptPath = quarantine(filePath);
      if (fs.existsSync(backupPath)) {
        try {
          const restored = parseSettings(backupPath);
          lastLoadIssue = { kind: 'backup', corruptPath, message: error.message };
          return restored;
        } catch {
          quarantine(backupPath);
        }
      }
      lastLoadIssue = { kind: 'reset', corruptPath, message: error.message };
      return normalizeSettings();
    }
  }
  function readable(targetPath) {
    try { parseSettings(targetPath); return true; } catch { return false; }
  }
  // 只有主文件本身完好时才把它存成「上一版」：坏文件覆盖掉好备份，下一次就两份都没了。
  function write(settings) {
    const normalized = normalizeSettings(settings);
    if (fs.existsSync(filePath) && readable(filePath)) atomicWrite(backupPath, fs.readFileSync(filePath, 'utf8'));
    atomicWrite(filePath, JSON.stringify(normalized, null, 2) + '\n');
    return normalized;
  }
  function publicSettings(settings = load()) { return { ...settings }; }
  function applyUpdate(current, update) {
    return normalizeSettings({ ...current, ...(update.settings || {}) });
  }
  return { directory, filePath, backupPath, load, write, publicSettings, applyUpdate, normalizeSettings, lastLoadIssue: () => lastLoadIssue };
}
module.exports = { createConfigStore, normalizeSettings, DEFAULT_SETTINGS, SCHEMA_VERSION, PLAIN_FIELDS, THEMES };
