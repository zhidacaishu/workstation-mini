const crypto = require('node:crypto');
const { extractTasks } = require('./tasks');
const { stripMachineDirectives } = require('./machineDirectives');
const { isValidDateString } = require('./dates');
const { readNote, writeNote } = require('./vault/note');
const { enqueueNote } = require('./vault/note-queue');
const { httpError } = require('./routes/http');

// 短期保存每次待办写入前的原始 Markdown 行，供撤销按原文精确还原（包括多个日期及原位置）。
const MAX_UNDO_ENTRIES = 64;
const undoEntries = new Map();

function rememberUndo(entry) {
  const token = crypto.randomUUID();
  undoEntries.set(token, entry);
  while (undoEntries.size > MAX_UNDO_ENTRIES) {
    const oldest = undoEntries.keys().next().value;
    undoEntries.delete(oldest);
  }
  return token;
}

async function updateTask(notesDir, { path, line, expectedHash, done, due }) {
  if (!Number.isSafeInteger(line) || line < 1 || !expectedHash) throw httpError(400, '缺少任务位置或笔记版本。');
  if (done !== undefined && typeof done !== 'boolean') throw httpError(400, '任务状态不合法。');
  if (due !== undefined && (typeof due !== 'string' || (due && !isValidDateString(due)))) throw httpError(400, '日期应为有效的 YYYY-MM-DD，或留空取消排期。');
  if (done === undefined && due === undefined) throw httpError(400, '没有要修改的内容。');
  return enqueueNote(notesDir, path, async () => {
    let note;
    try { note = await readNote(notesDir, path); }
    catch (error) {
      if (error.code === 'ENOENT') throw httpError(409, '笔记已被删除或移动，请刷新后重试。');
      throw error;
    }
    if (note.hash !== expectedHash) throw httpError(409, '笔记已在别处修改，请刷新后重试。');
    // 和索引、阅读页同一套规则认待办：机器指令行先去掉（不增删行），再解析。
    const task = extractTasks(stripMachineDirectives(note.body), { includeDates: true }).find(item => item.line === line);
    if (!task) throw httpError(409, '原位置已不是待办，请刷新后重试。');
    // gray-matter exposes the body as a suffix. Preserve its exact prefix,
    // including YAML comments, BOM, and the original newline convention.
    if (!note.raw.endsWith(note.body)) throw httpError(409, '无法安全定位笔记正文。');
    // 切行时留住每行原来的换行符（\r\n、\r 或 \n），只改目标那一行。
    const parts = note.body.split(/(\r\n|\r|\n)/);
    const originalLine = parts[(line - 1) * 2];
    let target = originalLine;
    if (done !== undefined) target = target.replace(/^(\s*[-*+]\s+\[)[ xX](\])/, (_, a, b) => a + (done ? 'x' : ' ') + b);
    if (due !== undefined) {
      const dates = due ? task.dates.slice(0, 1) : task.dates;
      for (const tag of dates.slice().reverse()) {
        target = target.slice(0, tag.index) + (due ? '@' + due : '') + target.slice(tag.index + 1 + tag.date.length);
      }
      if (due && !dates.length) target = target.replace(/^(\s*[-*+]\s+\[[ xX]\]\s+)/, '$1@' + due + ' ');
    }
    parts[(line - 1) * 2] = target;
    const raw = note.raw.slice(0, note.raw.length - note.body.length) + parts.join('');
    const result = await writeNote(notesDir, path, { raw });
    const undoToken = rememberUndo({ notesDir, path, line, afterHash: result.hash, originalLine });
    return { hash: result.hash, undoToken };
  });
}

async function undoTask(notesDir, { undoToken, expectedHash = '' }) {
  const token = String(undoToken || '');
  const entry = token ? undoEntries.get(token) : null;
  if (!entry || entry.notesDir !== notesDir) throw httpError(409, '这条撤销记录已过期或已使用。');
  return enqueueNote(notesDir, entry.path, async () => {
    if (undoEntries.get(token) !== entry) throw httpError(409, '这条撤销记录已使用。');
    let note;
    try { note = await readNote(notesDir, entry.path); }
    catch (error) {
      if (error.code === 'ENOENT') {
        undoEntries.delete(token);
        throw httpError(409, '笔记已被删除或移动，无法自动撤销。');
      }
      throw error;
    }
    if (note.hash !== entry.afterHash || (expectedHash && note.hash !== expectedHash)) {
      undoEntries.delete(token);
      throw httpError(409, '笔记已在别处修改，无法自动撤销。');
    }
    if (!note.raw.endsWith(note.body)) throw httpError(409, '无法安全定位笔记正文。');
    const parts = note.body.split(/(\r\n|\r|\n)/);
    if ((entry.line - 1) * 2 >= parts.length) {
      undoEntries.delete(token);
      throw httpError(409, '笔记内容已变化，无法自动撤销。');
    }
    parts[(entry.line - 1) * 2] = entry.originalLine;
    const raw = note.raw.slice(0, note.raw.length - note.body.length) + parts.join('');
    const written = await writeNote(notesDir, entry.path, { raw });
    undoEntries.delete(token);
    return { hash: written.hash, path: entry.path };
  });
}

module.exports = { updateTask, undoTask };
