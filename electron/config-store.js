const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { replaceFileSync } = require('../src/vault/atomic');

const SCHEMA_VERSION = 3;
const SECRET_FIELDS = [
  'anthropicApiKey', 'journalTrackerPassword', 'blobServerToken', 'mineruApiToken'
];
const PLAIN_FIELDS = [
  'vaultDir', 'device', 'readOnly', 'syncEnabled', 'syncIntervalMinutes',
  'zoteroApi', 'zoteroDataDir', 'journalTrackerUrl', 'journalTrackerEmail',
  'checkDraftPath', 'pythonPath', 'whisperPath', 'whisperModel', 'blogRepo',
  'launchAtLogin', 'blobServerUrl', 'updatesEnabled',
  'remindersEnabled', 'reminderLeadMinutes'
];

const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  vaultDir: '',
  device: '',
  readOnly: false,
  syncEnabled: false,
  syncIntervalMinutes: 15,
  zoteroApi: 'http://localhost:23119/api/users/0',
  zoteroDataDir: '',
  journalTrackerUrl: '',
  journalTrackerEmail: '',
  checkDraftPath: '',
  pythonPath: process.platform === 'win32' ? 'python' : 'python3',
  whisperPath: '',
  whisperModel: '',
  blogRepo: '',
  launchAtLogin: false,
  blobServerUrl: '',
  // 默认开着，和 launchAtLogin / syncEnabled 不同。那两个默认关是因为它们会
  // 改变系统状态或往远端写东西；检查更新只是从你自己那台存储服务上取一个
  // 版本号，而且没配存储服务时它根本不生效 —— 等于已经是显式选择进来的。
  updatesEnabled: true,
  // 默认关：它会主动弹系统通知打断你。这类「应用替你决定什么时候该被打扰」的
  // 功能必须是显式打开的。
  remindersEnabled: false,
  reminderLeadMinutes: 10,
  secrets: {}
});

/**
 * 原子写设置文件。
 *
 * rename 走 replaceFileSync 而不是裸 fs.renameSync：这个应用发 Windows，
 * 而那边的 rename 会被杀毒软件和索引服务的瞬时句柄打断（EPERM/EACCES/EBUSY）。
 * vault 里的笔记和附件早就为此走 atomic.js 的重试了，settings.json 却没有 ——
 * 而它偏偏是被夹在「改设置 → 重启运行时 → 失败就整体回滚」中间的那一次写入，
 * 在这里失败会把一份本来合法的新配置连坐掉。
 *
 * 临时文件名用 randomUUID 而不是 Date.now()：同一毫秒内的两次写入（保存设置
 * 紧接着换资料库）会撞出同一个名字，后写的那次直接盖掉前一次的临时文件。
 */
function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    replaceFileSync(temporary, filePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function normalizeSettings(value = {}) {
  const plain = Object.fromEntries(
    PLAIN_FIELDS
      .filter(field => Object.hasOwn(value, field))
      .map(field => [field, value[field]])
  );
  const settings = {
    ...DEFAULT_SETTINGS,
    ...plain,
    schemaVersion: SCHEMA_VERSION,
    secrets: value.secrets && typeof value.secrets === 'object' && !Array.isArray(value.secrets)
      ? Object.fromEntries(
          SECRET_FIELDS
            .filter(field => typeof value.secrets[field] === 'string' && value.secrets[field])
            .map(field => [field, value.secrets[field]])
        )
      : {}
  };
  const interval = Number(settings.syncIntervalMinutes);
  settings.syncIntervalMinutes = Number.isFinite(interval)
    ? Math.min(Math.max(Math.trunc(interval), 1), 1_440)
    : 15;
  settings.readOnly = Boolean(settings.readOnly);
  settings.syncEnabled = Boolean(settings.syncEnabled);
  settings.launchAtLogin = Boolean(settings.launchAtLogin);
  // 老设置文件里没有这个字段，落回默认值 true，而不是被 Boolean(undefined) 判成关闭 ——
  // 「升级之后自动更新反而悄悄关了」是最不该出现的那种默认值 bug。
  settings.updatesEnabled = settings.updatesEnabled === undefined
    ? DEFAULT_SETTINGS.updatesEnabled
    : Boolean(settings.updatesEnabled);
  settings.remindersEnabled = Boolean(settings.remindersEnabled);
  const lead = Number(settings.reminderLeadMinutes);
  settings.reminderLeadMinutes = Number.isFinite(lead)
    ? Math.min(Math.max(Math.trunc(lead), 1), 120)
    : DEFAULT_SETTINGS.reminderLeadMinutes;
  for (const key of ['vaultDir', 'device', 'zoteroApi', 'zoteroDataDir', 'journalTrackerUrl',
    'journalTrackerEmail', 'checkDraftPath', 'pythonPath', 'whisperPath', 'whisperModel', 'blogRepo']) {
    settings[key] = typeof settings[key] === 'string' ? settings[key].trim() : '';
  }
  return settings;
}

function createConfigStore({ userDataPath, safeStorage }) {
  const directory = path.join(userDataPath, 'workstation-data');
  const filePath = path.join(directory, 'settings.json');
  const backupPath = path.join(directory, 'settings.previous.json');

  function parseSettings(targetPath) {
    const parsed = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    if (Number(parsed.schemaVersion || 0) > SCHEMA_VERSION) {
      const error = new Error('设置来自更新版本的科研工作台，请升级应用后再打开。');
      error.code = 'SETTINGS_TOO_NEW';
      throw error;
    }
    const migrated = Number(parsed.schemaVersion || 0) < 2 && !Object.hasOwn(parsed, 'syncEnabled')
      ? { ...parsed, syncEnabled: true }
      : parsed;
    return normalizeSettings(migrated);
  }

  function load() {
    if (!fs.existsSync(filePath)) return normalizeSettings();
    try {
      return parseSettings(filePath);
    } catch (error) {
      if (error.code === 'SETTINGS_TOO_NEW') throw error;
      if (fs.existsSync(backupPath)) {
        try {
          return parseSettings(backupPath);
        } catch {}
      }
      throw new Error(`设置文件损坏：${error.message}`);
    }
  }

  function write(settings) {
    const normalized = normalizeSettings(settings);
    if (fs.existsSync(filePath)) atomicWrite(backupPath, fs.readFileSync(filePath, 'utf8'));
    atomicWrite(filePath, `${JSON.stringify(normalized, null, 2)}\n`);
    return normalized;
  }

  function publicSettings(settings = load()) {
    const { secrets, ...plain } = settings;
    return {
      ...plain,
      secrets: Object.fromEntries(SECRET_FIELDS.map(field => [field, Boolean(secrets[field])]))
    };
  }

  function decryptSecret(settings, field) {
    const encoded = settings.secrets?.[field];
    if (!encoded) return '';
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统安全存储当前不可用，无法读取已保存的秘密。');
    }
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  }

  function applyUpdate(current, update) {
    const next = normalizeSettings({ ...current, ...update.settings, secrets: current.secrets });
    const changes = update.secrets || {};

    for (const field of SECRET_FIELDS) {
      const change = changes[field];
      if (!change || change.action === 'keep') continue;
      if (change.action === 'clear') {
        delete next.secrets[field];
        continue;
      }
      if (change.action !== 'set' || typeof change.value !== 'string' || !change.value) {
        throw new Error(`秘密字段 ${field} 的更新无效。`);
      }
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('系统安全存储当前不可用，不能保存秘密。');
      }
      next.secrets[field] = safeStorage.encryptString(change.value).toString('base64');
    }

    return next;
  }

  // 按 SECRET_FIELDS 遍历，而不是把字段名再抄一遍：抄一遍的话，新增一个秘密
  // 就得记得改三处（字段表、加解密、这里），漏掉这处的表现是「设置里填了、
  // 保存也成功了，运行时就是读不到」—— 没有任何报错，最难查的那种。
  function runtimeSecrets(settings = load()) {
    return Object.fromEntries(SECRET_FIELDS.map(field => [field, decryptSecret(settings, field)]));
  }

  return {
    directory,
    filePath,
    backupPath,
    load,
    write,
    publicSettings,
    applyUpdate,
    runtimeSecrets
  };
}

module.exports = { createConfigStore, normalizeSettings, DEFAULT_SETTINGS, SCHEMA_VERSION };
