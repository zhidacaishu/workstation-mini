const path = require('node:path');

const BOOLEAN_FIELDS = new Set(['readOnly', 'syncEnabled', 'launchAtLogin']);
const STRING_LIMITS = new Map([['vaultDir', 32767], ['device', 128], ['checkDraftPath', 32767], ['pythonPath', 32767]]);
const ABSOLUTE_PATH_FIELDS = new Set(['vaultDir', 'checkDraftPath']);
const SECRET_FIELDS = new Set(['anthropicApiKey']);
const TOP_LEVEL_FIELDS = new Set(['settings', 'secrets']);
const SETTING_FIELDS = new Set([...BOOLEAN_FIELDS, ...STRING_LIMITS.keys(), 'syncIntervalMinutes']);
function isRecord(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function rejectUnknownFields(value, allowed, label) { for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`未知${label}字段：${key}`); }
function validateString(name, value) { if (typeof value !== 'string') throw new Error(`设置字段 ${name} 必须是文本。`); if (value.length > STRING_LIMITS.get(name)) throw new Error(`设置字段 ${name} 过长。`); if (value.includes('\0')) throw new Error(`设置字段 ${name} 包含无效字符。`); }
function validateSecretChange(field, change) { if (!isRecord(change)) throw new Error(`秘密字段 ${field} 的更新无效。`); rejectUnknownFields(change, new Set(['action', 'value']), `秘密字段 ${field} 的`); if (!['keep', 'set', 'clear'].includes(change.action)) throw new Error(`秘密字段 ${field} 的操作无效。`); if (change.action === 'set' && (typeof change.value !== 'string' || !change.value || change.value.length > 32768)) throw new Error(`秘密字段 ${field} 的值无效。`); if (change.action !== 'set' && Object.hasOwn(change, 'value')) throw new Error(`秘密字段 ${field} 只有设置新值时才能携带内容。`); }
function validateSettingsUpdate(update) {
  if (!isRecord(update)) throw new Error('设置数据无效。'); rejectUnknownFields(update, TOP_LEVEL_FIELDS, '设置数据');
  if (!isRecord(update.settings)) throw new Error('设置数据无效。'); rejectUnknownFields(update.settings, SETTING_FIELDS, '设置');
  for (const field of BOOLEAN_FIELDS) if (Object.hasOwn(update.settings, field) && typeof update.settings[field] !== 'boolean') throw new Error(`设置字段 ${field} 必须是布尔值。`);
  for (const [field] of STRING_LIMITS) if (Object.hasOwn(update.settings, field)) validateString(field, update.settings[field]);
  if (Object.hasOwn(update.settings, 'syncIntervalMinutes') && (!Number.isInteger(update.settings.syncIntervalMinutes) || update.settings.syncIntervalMinutes < 1 || update.settings.syncIntervalMinutes > 1440)) throw new Error('同步间隔必须是 1 到 1440 之间的整数。');
  const vaultDir = update.settings.vaultDir?.trim(); if (!vaultDir || !path.isAbsolute(vaultDir)) throw new Error('资料库必须是绝对路径。');
  for (const field of ABSOLUTE_PATH_FIELDS) { const value = update.settings[field]?.trim(); if (field !== 'vaultDir' && value && !path.isAbsolute(value)) throw new Error(`设置字段 ${field} 必须是绝对路径。`); }
  if (update.secrets !== undefined) { if (!isRecord(update.secrets)) throw new Error('秘密设置数据无效。'); rejectUnknownFields(update.secrets, SECRET_FIELDS, '秘密'); for (const [field, change] of Object.entries(update.secrets)) validateSecretChange(field, change); }
}
module.exports = { validateSettingsUpdate };
