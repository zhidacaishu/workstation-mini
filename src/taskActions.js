const { extractTasks } = require('./tasks');
const { maskCode } = require('./vault/wikilink');
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
    const note = await readNote(notesDir, path);
    if (note.hash !== expectedHash) throw httpError(409, '笔记已在别处修改，请刷新后重试。');
    if (!extractTasks(note.body).some(task => task.line === line)) throw httpError(409, '原位置已不是待办，请刷新后重试。');
    // gray-matter exposes the body as a suffix. Preserve its exact prefix,
    // including YAML comments, BOM, and the original newline convention.
    if (!note.raw.endsWith(note.body)) throw httpError(409, '无法安全定位笔记正文。');
    const lines = note.body.split('\n');
    let target = lines[line - 1];
    if (done !== undefined) target = target.replace(/^(\s*[-*+]\s+\[)[ xX](\])/, (_, a, b) => a + (done ? 'x' : ' ') + b);
    if (due !== undefined) {
      // Match the extractor's full-document context: inline code may span lines.
      const masked = maskCode(note.body).split('\n')[line - 1];
      const match = /@\d{4}-\d{2}-\d{2}\b/.exec(masked);
      if (match) target = target.slice(0, match.index) + (due ? '@' + due : '') + target.slice(match.index + match[0].length);
      else if (due) target = target.replace(/^(\s*[-*+]\s+\[[ xX]\]\s+)/, '$1@' + due + ' ');
    }
    lines[line - 1] = target;
    const raw = note.raw.slice(0, note.raw.length - note.body.length) + lines.join('\n');
    const result = await writeNote(notesDir, path, { raw });
    return { hash: result.hash };
  });
}
module.exports = { updateTask };
