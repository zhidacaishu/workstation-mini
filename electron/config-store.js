const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { replaceFileSync } = require('../src/vault/atomic');

const SCHEMA_VERSION = 5;
const PLAIN_FIELDS = ['vaultDir', 'device', 'readOnly', 'syncEnabled', 'syncIntervalMinutes', 'launchAtLogin'];
const DEFAULT_SETTINGS = Object.freeze({ schemaVersion: SCHEMA_VERSION, vaultDir: '', device: '', readOnly: false, syncEnabled: false, syncIntervalMinutes: 15, launchAtLogin: false });

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = filePath + '.tmp-' + process.pid + '-' + crypto.randomUUID();
  try { fs.writeFileSync(temporary, content, 'utf8'); replaceFileSync(temporary, filePath); }
  catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
}
function normalizeSettings(value = {}) {
  const plain = Object.fromEntries(PLAIN_FIELDS.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]]));
  const settings = { ...DEFAULT_SETTINGS, ...plain, schemaVersion: SCHEMA_VERSION };
  const interval = Number(settings.syncIntervalMinutes);
  settings.syncIntervalMinutes = Number.isFinite(interval) ? Math.min(Math.max(Math.trunc(interval), 1), 1440) : 15;
  settings.readOnly = Boolean(settings.readOnly); settings.syncEnabled = Boolean(settings.syncEnabled); settings.launchAtLogin = Boolean(settings.launchAtLogin);
  for (const key of ['vaultDir', 'device']) settings[key] = typeof settings[key] === 'string' ? settings[key].trim() : '';
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
  function load() {
    if (!fs.existsSync(filePath)) return normalizeSettings();
    try { return parseSettings(filePath); } catch (error) {
      if (error.code === 'SETTINGS_TOO_NEW') throw error;
      if (fs.existsSync(backupPath)) { try { return parseSettings(backupPath); } catch {} }
      throw new Error('设置文件损坏：' + error.message);
    }
  }
  function write(settings) { const normalized = normalizeSettings(settings); if (fs.existsSync(filePath)) atomicWrite(backupPath, fs.readFileSync(filePath, 'utf8')); atomicWrite(filePath, JSON.stringify(normalized, null, 2) + '\n'); return normalized; }
  function publicSettings(settings = load()) { return { ...settings }; }
  function applyUpdate(current, update) {
    return normalizeSettings({ ...current, ...(update.settings || {}) });
  }
  return { directory, filePath, backupPath, load, write, publicSettings, applyUpdate, normalizeSettings };
}
module.exports = { createConfigStore, normalizeSettings, DEFAULT_SETTINGS, SCHEMA_VERSION, PLAIN_FIELDS };
