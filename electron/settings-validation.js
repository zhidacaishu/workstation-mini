const path = require('node:path');

const BOOLEAN_FIELDS = new Set(['readOnly', 'syncEnabled', 'launchAtLogin']);
const STRING_LIMITS = new Map([['vaultDir', 32767], ['device', 128]]);
const TOP_LEVEL_FIELDS = new Set(['settings']);
const SETTING_FIELDS = new Set([...BOOLEAN_FIELDS, ...STRING_LIMITS.keys(), 'syncIntervalMinutes']);
function isRecord(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function rejectUnknownFields(value, allowed, label) { for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`未知${label}字段：${key}`); }
function validateString(name, value) { if (typeof value !== 'string') throw new Error(`设置字段 ${name} 必须是文本。`); if (value.length > STRING_LIMITS.get(name)) throw new Error(`设置字段 ${name} 过长。`); if (value.includes('\0')) throw new Error(`设置字段 ${name} 包含无效字符。`); }
function validateSettingsUpdate(update) {
  if (!isRecord(update)) throw new Error('设置数据无效。'); rejectUnknownFields(update, TOP_LEVEL_FIELDS, '设置数据');
  if (!isRecord(update.settings)) throw new Error('设置数据无效。'); rejectUnknownFields(update.settings, SETTING_FIELDS, '设置');
  for (const field of BOOLEAN_FIELDS) if (Object.hasOwn(update.settings, field) && typeof update.settings[field] !== 'boolean') throw new Error(`设置字段 ${field} 必须是布尔值。`);
  for (const [field] of STRING_LIMITS) if (Object.hasOwn(update.settings, field)) validateString(field, update.settings[field]);
  if (Object.hasOwn(update.settings, 'syncIntervalMinutes') && (!Number.isInteger(update.settings.syncIntervalMinutes) || update.settings.syncIntervalMinutes < 1 || update.settings.syncIntervalMinutes > 1440)) throw new Error('同步间隔必须是 1 到 1440 之间的整数。');
  const vaultDir = update.settings.vaultDir?.trim(); if (!vaultDir || !path.isAbsolute(vaultDir)) throw new Error('资料库必须是绝对路径。');
}
module.exports = { validateSettingsUpdate };
