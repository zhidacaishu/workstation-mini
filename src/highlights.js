const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { toLocalDate } = require('./templates');
const { appendLinesSync } = require('./vault/atomic');

const EXPOSURE_DIR = 'reviews';
const EXPOSURE_PREFIX = 'highlights';

/**
 * 每日高亮回顾。
 *
 * 方案里说它是 FSRS 的退化形式，实现下来更准确的说法是：**它不是 FSRS**。
 * FSRS 靠「你记得多牢」的评分驱动排期，而回顾这件事没有评分 —— 你只是又看了一眼。
 * 硬套 FSRS 得给每次曝光编一个分数，那是假数据。
 *
 * 所以这里用的是最朴素也最诚实的规则：**越久没看见的越优先**，从没看见过的排最前。
 * 复用的是事件日志那套模式（追加式、按设备分文件、可重放），不是调度器本身。
 */
function exposureFile(dateString, device) {
  return `${EXPOSURE_PREFIX}-${dateString.slice(0, 7)}-${device}.jsonl`;
}

async function readExposures(vaultDir) {
  const dir = path.join(vaultDir, EXPOSURE_DIR);
  let files;
  try {
    files = (await fsp.readdir(dir)).filter(name => name.startsWith(`${EXPOSURE_PREFIX}-`) && name.endsWith('.jsonl'));
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }

  // 只保留每个目标最近一次曝光时间 —— 这是排序唯一需要的东西。
  const lastSeen = new Map();
  for (const file of files.sort()) {
    const raw = await fsp.readFile(path.join(dir, file), 'utf8');
    for (const line of raw.split('\n')) {
      const text = line.trim();
      if (!text) continue;
      try {
        const event = JSON.parse(text);
        if (!event?.path || typeof event.ts !== 'string') continue;
        const previous = lastSeen.get(event.path);
        if (!previous || event.ts > previous) lastSeen.set(event.path, event.ts);
      } catch {
        // 坏行跳过，不让一条残行拖垮整个回顾。
      }
    }
  }
  return lastSeen;
}

function createHighlights({ vaultDir, device, db, now = () => new Date() }) {
  /**
   * 今天该回顾哪几条。
   *
   * 排序：从没看过的 → 最久没看过的。只取有实际内容的笔记，
   * 空壳笔记推给你看没有意义。
   */
  async function today({ count = 5, minLength = 120 } = {}) {
    const lastSeen = await readExposures(vaultDir);

    const candidates = db.raw.prepare(`
      SELECT path, title_raw AS title, body_raw AS body, section FROM notes
    `).all().filter(note => note.body.replace(/\s/g, '').length >= minLength);

    return candidates
      .map(note => ({ ...note, lastSeen: lastSeen.get(note.path) || '' }))
      .sort((a, b) => {
        if (a.lastSeen !== b.lastSeen) return a.lastSeen < b.lastSeen ? -1 : 1;
        return a.path.localeCompare(b.path);
      })
      .slice(0, count)
      .map(note => ({
        path: note.path,
        title: note.title,
        section: note.section,
        excerpt: excerpt(note.body),
        lastSeen: note.lastSeen
      }));
  }

  /** 取一段有内容的正文做摘录，跳过标题行和空行。 */
  function excerpt(body, limit = 260) {
    const paragraph = String(body || '')
      .split(/\n{2,}/)
      .map(block => block.replace(/^#.*$/gm, '').trim())
      .find(block => block.replace(/\s/g, '').length > 40);
    const text = (paragraph || body || '').replace(/\s+/g, ' ').trim();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  }

  /** 记一次曝光。追加式，与复习事件同一套路数。 */
  function markSeen(notePaths) {
    const paths = [...new Set(notePaths.filter(Boolean))];
    if (paths.length === 0) return [];

    const at = now();
    const local = toLocalDate(at);
    const dir = path.join(vaultDir, EXPOSURE_DIR);
    fs.mkdirSync(dir, { recursive: true });

    const lines = paths.map(notePath => JSON.stringify({ path: notePath, ts: at.toISOString() }));
    appendLinesSync(path.join(dir, exposureFile(local, device)), lines);
    return paths;
  }

  return { today, markSeen, readExposures: () => readExposures(vaultDir) };
}

module.exports = { createHighlights, exposureFile, readExposures };
