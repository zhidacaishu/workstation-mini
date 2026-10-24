const path = require('node:path');
const { URL } = require('node:url');
const { normalizeBlobBaseUrl } = require('../src/blobs/url');

const BOOLEAN_FIELDS = new Set([
  'readOnly', 'syncEnabled', 'launchAtLogin', 'updatesEnabled', 'remindersEnabled'
]);
const STRING_LIMITS = new Map([
  ['vaultDir', 32_767],
  ['device', 128],
  ['zoteroApi', 4_096],
  ['zoteroDataDir', 32_767],
  ['journalTrackerUrl', 4_096],
  ['journalTrackerEmail', 320],
  ['checkDraftPath', 32_767],
  ['pythonPath', 32_767],
  ['whisperPath', 32_767],
  ['whisperModel', 32_767],
  ['blogRepo', 32_767],
  ['blobServerUrl', 4_096]
]);
const ABSOLUTE_PATH_FIELDS = new Set([
  'vaultDir', 'zoteroDataDir', 'checkDraftPath', 'whisperPath',
  'whisperModel', 'blogRepo'
]);
const HTTP_URL_FIELDS = new Set(['zoteroApi', 'journalTrackerUrl', 'blobServerUrl']);
const SECRET_FIELDS = new Set([
  'anthropicApiKey', 'journalTrackerPassword', 'blobServerToken', 'mineruApiToken'
]);
const TOP_LEVEL_FIELDS = new Set(['settings', 'secrets']);
const SETTING_FIELDS = new Set([
  ...BOOLEAN_FIELDS,
  ...STRING_LIMITS.keys(),
  'syncIntervalMinutes',
  'reminderLeadMinutes'
]);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`未知${label}字段：${key}`);
  }
}

function validateString(name, value) {
  if (typeof value !== 'string') throw new Error(`设置字段 ${name} 必须是文本。`);
  if (value.length > STRING_LIMITS.get(name)) throw new Error(`设置字段 ${name} 过长。`);
  if (value.includes('\0')) throw new Error(`设置字段 ${name} 包含无效字符。`);
}

function validateHttpUrl(name, value) {
  if (!value.trim()) return;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`设置字段 ${name} 必须是有效网址。`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`设置字段 ${name} 只允许 HTTP 或 HTTPS 地址。`);
  }
  if (url.username || url.password) {
    throw new Error(`设置字段 ${name} 不能在网址中包含账号或密码。`);
  }
}

function validateSecretChange(field, change) {
  if (!isRecord(change)) throw new Error(`秘密字段 ${field} 的更新无效。`);
  rejectUnknownFields(change, new Set(['action', 'value']), `秘密字段 ${field} 的`);
  if (!['keep', 'set', 'clear'].includes(change.action)) {
    throw new Error(`秘密字段 ${field} 的操作无效。`);
  }
  if (change.action === 'set') {
    if (typeof change.value !== 'string' || !change.value || change.value.length > 32_768) {
      throw new Error(`秘密字段 ${field} 的值无效。`);
    }
    return;
  }
  if (Object.hasOwn(change, 'value')) {
    throw new Error(`秘密字段 ${field} 只有设置新值时才能携带内容。`);
  }
}

/**
 * @param update 设置页提交的整份更新。
 * @param current 当前已保存的设置，用来判断某个字段到底改没改。
 *
 * 设置页每次提交都会把所有字段原样带上，包括用户这次根本没动的那些。
 * blobServerUrl 的校验后来收紧成「远程必须 HTTPS」，于是按旧文档配了
 * `http://100.x.x.x:4100`（Tailscale 的 CGNAT 地址，不算回环）的安装会卡死：
 * 想改设备名，提交里带着那个老地址，整份更新被拒，连把它清掉都做不到。
 * 所以没改过的值只做通用校验，收紧后的规则只拦真正的新值。
 */
function validateSettingsUpdate(update, current = {}) {
  if (!isRecord(update)) throw new Error('设置数据无效。');
  rejectUnknownFields(update, TOP_LEVEL_FIELDS, '设置数据');
  if (!isRecord(update.settings)) throw new Error('设置数据无效。');
  rejectUnknownFields(update.settings, SETTING_FIELDS, '设置');

  for (const field of BOOLEAN_FIELDS) {
    if (Object.hasOwn(update.settings, field) && typeof update.settings[field] !== 'boolean') {
      throw new Error(`设置字段 ${field} 必须是布尔值。`);
    }
  }

  for (const [field] of STRING_LIMITS) {
    if (Object.hasOwn(update.settings, field)) validateString(field, update.settings[field]);
  }

  if (Object.hasOwn(update.settings, 'syncIntervalMinutes')) {
    const interval = update.settings.syncIntervalMinutes;
    if (!Number.isInteger(interval) || interval < 1 || interval > 1_440) {
      throw new Error('同步间隔必须是 1 到 1440 之间的整数。');
    }
  }

  if (Object.hasOwn(update.settings, 'reminderLeadMinutes')) {
    const lead = update.settings.reminderLeadMinutes;
    if (!Number.isInteger(lead) || lead < 1 || lead > 120) {
      throw new Error('提醒提前量必须是 1 到 120 之间的整数。');
    }
  }

  const vaultDir = update.settings.vaultDir?.trim();
  if (!vaultDir || !path.isAbsolute(vaultDir)) throw new Error('资料库必须是绝对路径。');

  for (const field of ABSOLUTE_PATH_FIELDS) {
    const value = update.settings[field]?.trim();
    if (field !== 'vaultDir' && value && !path.isAbsolute(value)) {
      throw new Error(`设置字段 ${field} 必须是绝对路径。`);
    }
  }

  for (const field of HTTP_URL_FIELDS) {
    if (!Object.hasOwn(update.settings, field)) continue;
    const value = update.settings[field];
    const unchanged = String(current?.[field] ?? '').trim() === String(value).trim();
    if (field === 'blobServerUrl' && value.trim() && !unchanged) {
      try {
        normalizeBlobBaseUrl(value);
      } catch (error) {
        throw new Error(`设置字段 ${field}：${error.message}`);
      }
    } else {
      validateHttpUrl(field, value);
    }
  }

  const email = update.settings.journalTrackerEmail?.trim();
  if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new Error('journal-tracker 邮箱格式无效。');
  }

  if (update.secrets === undefined) return;
  if (!isRecord(update.secrets)) throw new Error('秘密设置数据无效。');
  rejectUnknownFields(update.secrets, SECRET_FIELDS, '秘密');
  for (const [field, change] of Object.entries(update.secrets)) {
    validateSecretChange(field, change);
  }
}

module.exports = { validateSettingsUpdate };
