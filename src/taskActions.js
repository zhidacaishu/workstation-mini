const { extractTasks, dueTagOf } = require('./tasks');
const { stripMachineDirectives } = require('./machineDirectives');
const { isValidDateString } = require('./dates');
const { readNote, writeNote } = require('./vault/note');
const { enqueueNote } = require('./vault/note-queue');
const { httpError } = require('./routes/http');

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
    const task = extractTasks(stripMachineDirectives(note.body)).find(item => item.line === line);
    if (!task) throw httpError(409, '原位置已不是待办，请刷新后重试。');
    // gray-matter exposes the body as a suffix. Preserve its exact prefix,
    // including YAML comments, BOM, and the original newline convention.
    if (!note.raw.endsWith(note.body)) throw httpError(409, '无法安全定位笔记正文。');
    // 切行时留住每行原来的换行符（\r\n、\r 或 \n），只改目标那一行。
    const parts = note.body.split(/(\r\n|\r|\n)/);
    let target = parts[(line - 1) * 2];
    if (done !== undefined) target = target.replace(/^(\s*[-*+]\s+\[)[ xX](\])/, (_, a, b) => a + (done ? 'x' : ' ') + b);
    if (due !== undefined) {
      const match = task.due ? dueTagOf(target, task.due) : null;
      if (match) target = target.slice(0, match.index) + (due ? '@' + due : '') + target.slice(match.index + match[0].length);
      else if (due) target = target.replace(/^(\s*[-*+]\s+\[[ xX]\]\s+)/, '$1@' + due + ' ');
    }
    parts[(line - 1) * 2] = target;
    const raw = note.raw.slice(0, note.raw.length - note.body.length) + parts.join('');
    const result = await writeNote(notesDir, path, { raw });
    return { hash: result.hash };
  });
}
module.exports = { updateTask };
