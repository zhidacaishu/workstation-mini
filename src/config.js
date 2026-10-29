const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const DEVICE_BASE_MAX_LENGTH = 64;
function normalizeDeviceName(value) { const original = String(value || '').normalize('NFC'); if (!original) return 'unknown'; if (/^[a-z0-9_-]+$/.test(original) && original.length <= DEVICE_BASE_MAX_LENGTH) return original; const normalized = original.trim().toLowerCase(); const safe = normalized.replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, DEVICE_BASE_MAX_LENGTH).replace(/-+$/g, ''); const base = safe || 'unknown'; const suffix = crypto.createHash('sha256').update(original, 'utf8').digest('hex').slice(0, 10); return base + '-' + suffix; }
/**
 * 新设备第一次启动时生成的设备名：主机名打底，加一段随机后缀。
 *
 * 复习日志按「年月 + 设备名」分文件，两台设备同名就会往同一个文件里追加，
 * git 同步时必然冲突；而默认的主机名并不可靠——两台同型号笔记本经常同名，
 * macOS 在校园网等环境里还会随网络改主机名。所以生成一次就存进设置，之后不再变。
 */
function createDeviceName(hostname = os.hostname(), suffix = crypto.randomBytes(3).toString('hex')) {
  const base = String(hostname || '').normalize('NFKC').toLowerCase().replace(/\.local$/, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `${base || 'device'}-${suffix}`;
}
/**
 * 升级前没有保存设备名的老用户：复习日志一直按主机名算出的名字分文件。
 * 第一次保存时沿用那个名字，不换成新的随机名，日志就不会从此换一个文件。
 */
function legacyDeviceName(hostname = os.hostname()) {
  return normalizeDeviceName(hostname);
}
function defaultVaultDir() { return path.join(os.homedir(), 'workstation-vault'); }
function optionalText(value) { return typeof value === 'string' ? value.trim() : ''; }
function positiveNumber(value, fallback) { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : fallback; }
function loadConfig(settings = {}) { const vaultDir = path.resolve(settings.vaultDir || defaultVaultDir()); return { host: '127.0.0.1', port: 0, isProduction: Boolean(settings.isProduction), internalToken: optionalText(settings.internalToken), vaultDir, notesDir: path.join(vaultDir, 'notes'), reviewsDir: path.join(vaultDir, 'reviews'), attachmentsDir: path.join(vaultDir, 'attachments'), dbPath: settings.dbPath === ':memory:' ? ':memory:' : path.resolve(settings.dbPath || path.join(vaultDir, 'workstation.db')), readOnly: Boolean(settings.readOnly), windowChrome: settings.windowChrome === 'inset' ? 'inset' : 'native', device: normalizeDeviceName(settings.device || os.hostname()), syncEnabled: settings.syncEnabled !== false, syncIntervalMinutes: positiveNumber(settings.syncIntervalMinutes, 15) }; }
module.exports = { loadConfig, normalizeDeviceName, createDeviceName, legacyDeviceName, defaultVaultDir };
