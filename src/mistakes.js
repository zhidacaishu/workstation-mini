const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { toLocalDate } = require('./templates');
const { appendLinesSync } = require('./vault/atomic');

const MISTAKES_DIR = 'mistakes';
const SOURCES = { WRITING: 'writing', EXERCISE: 'exercise' };

// 习题错因。分类的意义不在于贴标签，而在于统计之后能看出
// 「我反复在同一个地方栽跟头」——那种自己意识不到的模式。
const EXERCISE_REASONS = [
  { key: 'concept', label: '概念混淆' },
  { key: 'calculation', label: '计算失误' },
  { key: 'misread', label: '读错题' },
  { key: 'method', label: '方法选错' },
  { key: 'incomplete', label: '想不完整' },
  { key: 'careless', label: '笔误' }
];

function reasonLabel(key) {
  return EXERCISE_REASONS.find(reason => reason.key === key)?.label || key;
}

/**
 * 错误实例的 ID。
 *
 * 由内容算出而非随机生成：同一份稿件重复跑检查器不该产生一堆重复记录。
 * 同一个位置的同一类错误，算出来永远是同一个 ID。
 */
function mistakeId(record) {
  const seed = [
    record.source, record.subject || '', record.category || '',
    record.ref || '', record.line ?? '', record.detail || ''
  ].join('\u0000');
  return crypto.createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 16);
}

function logName(dateString, device) {
  return `${dateString.slice(0, 7)}-${device}.jsonl`;
}

function isValidRecord(value) {
  return Boolean(value)
    && typeof value.id === 'string' && value.id.length > 0
    && (value.source === SOURCES.WRITING || value.source === SOURCES.EXERCISE)
    && typeof value.ts === 'string' && !Number.isNaN(Date.parse(value.ts))
    && typeof value.category === 'string' && value.category.length > 0;
}

/**
 * 读取全部错误记录。
 *
 * 与复习事件同一套路数：追加式 JSONL、按「年月 + 设备」分文件、坏行跳过。
 * 一次崩溃留下的半行 JSON 不该让整个错题本打不开。
 */
async function readMistakes(vaultDir) {
  const root = path.join(vaultDir, MISTAKES_DIR);
  const records = [];

  for (const source of Object.values(SOURCES)) {
    const dir = path.join(root, source);
    let files;
    try {
      files = (await fsp.readdir(dir)).filter(name => name.endsWith('.jsonl')).sort();
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const file of files) {
      const raw = await fsp.readFile(path.join(dir, file), 'utf8');
      for (const line of raw.split('\n')) {
        const text = line.trim();
        if (!text) continue;
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          continue;
        }
        if (isValidRecord(parsed)) records.push(parsed);
      }
    }
  }

  // 同一个 ID 只保留最早那条：重复跑检查器会重复落库，靠 ID 去重。
  const byId = new Map();
  for (const record of records.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))) {
    if (!byId.has(record.id)) byId.set(record.id, record);
  }
  return [...byId.values()];
}

/**
 * 按类别聚类统计。
 *
 * `count` 用的是检查器表头给的真实数量，`truncated` 是被渲染截掉、没能留下
 * 具体实例的部分。两者分开报，避免「实例少 = 问题少」的错觉。
 */
function clusterByCategory(records) {
  const byCategory = new Map();
  for (const record of records) {
    const key = `${record.source}\u0000${record.category}`;
    const entry = byCategory.get(key) || {
      source: record.source,
      category: record.category,
      tier: record.tier || '',
      total: 0,
      truncated: 0,
      instances: 0,
      latest: '',
      samples: []
    };
    entry.total += Number(record.count) || 1;
    entry.truncated += Number(record.truncated) || 0;
    entry.instances += 1;
    if (record.ts > entry.latest) entry.latest = record.ts;
    if (entry.samples.length < 3 && record.detail) entry.samples.push(record);
    byCategory.set(key, entry);
  }
  return [...byCategory.values()].sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));
}

/**
 * 按月统计，用来看某类错误是不是在减少。
 *
 * 分桶按**本地月**：ts 是 UTC 瞬时，直接 slice 会让月初凌晨记的错题落到上个月。
 * 和 aggregate.retrospective 的区间判断同一个口径。
 */
function monthlyTrend(records, months = 6) {
  const byMonth = new Map();
  for (const record of records) {
    const at = new Date(record.ts);
    if (Number.isNaN(at.getTime())) continue;
    const month = toLocalDate(at).slice(0, 7);
    byMonth.set(month, (byMonth.get(month) || 0) + (Number(record.count) || 1));
  }
  return [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(-months)
    .map(([month, total]) => ({ month, total }));
}

function createMistakeStore({ vaultDir, device, now = () => new Date() }) {
  function append(source, records) {
    if (records.length === 0) return [];
    const at = now();
    const dir = path.join(vaultDir, MISTAKES_DIR, source);
    fs.mkdirSync(dir, { recursive: true });

    const file = path.join(dir, logName(toLocalDate(at), device));
    appendLinesSync(file, records.map(record => JSON.stringify(record)));
    return records;
  }

  /**
   * 把一次检查结果落库。
   *
   * 每个「类别 × 位置」是一条记录。同一份稿件重复检查会算出相同的 ID，
   * 读取时去重，所以反复跑不会把统计冲爆。
   */
  function recordCheck(notePath, findings) {
    const ts = now().toISOString();
    const records = [];

    for (const finding of findings) {
      if (finding.instances.length === 0) {
        // 有些类别没有逐条位置（英美拼写混用、数字格式），只有一条汇总。
        const record = {
          source: SOURCES.WRITING,
          subject: notePath,
          category: finding.category,
          tier: finding.tier,
          count: finding.count,
          truncated: finding.truncated,
          ref: notePath,
          line: null,
          detail: '',
          note: '',
          ts
        };
        records.push({ ...record, id: mistakeId(record) });
        continue;
      }

      for (const instance of finding.instances) {
        const record = {
          source: SOURCES.WRITING,
          subject: notePath,
          category: finding.category,
          tier: finding.tier,
          count: 1,
          truncated: 0,
          ref: notePath,
          line: instance.line,
          detail: instance.detail,
          note: instance.note,
          ts
        };
        records.push({ ...record, id: mistakeId(record) });
      }

      // 被渲染截掉的那部分留一条记录，让统计数量与检查器表头一致。
      if (finding.truncated > 0) {
        const record = {
          source: SOURCES.WRITING,
          subject: notePath,
          category: finding.category,
          tier: finding.tier,
          count: finding.truncated,
          truncated: finding.truncated,
          ref: notePath,
          line: null,
          detail: `（另有 ${finding.truncated} 处同类问题，检查器输出只列前 25 条）`,
          note: '',
          ts
        };
        records.push({ ...record, id: mistakeId(record) });
      }
    }

    return append(SOURCES.WRITING, records);
  }

  /** 手工录入一条习题错题。 */
  function recordExercise({ subject = '', category = '', reason = '', detail = '', note = '', ref = '' }) {
    const trimmedCategory = String(category).trim();
    if (!trimmedCategory) throw new Error('题型不能为空');

    const record = {
      source: SOURCES.EXERCISE,
      subject: String(subject).trim(),
      category: trimmedCategory,
      tier: String(reason).trim(),
      count: 1,
      truncated: 0,
      ref: String(ref).trim(),
      line: null,
      detail: String(detail).trim(),
      note: String(note).trim(),
      ts: now().toISOString()
    };
    const withId = { ...record, id: mistakeId(record) };
    append(SOURCES.EXERCISE, [withId]);
    return withId;
  }

  return {
    recordCheck,
    recordExercise,
    all: () => readMistakes(vaultDir)
  };
}

module.exports = {
  MISTAKES_DIR,
  SOURCES,
  EXERCISE_REASONS,
  reasonLabel,
  mistakeId,
  logName,
  isValidRecord,
  readMistakes,
  clusterByCategory,
  monthlyTrend,
  createMistakeStore
};
