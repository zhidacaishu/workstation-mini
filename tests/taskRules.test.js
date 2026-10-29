const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { extractTasks } = require('../src/tasks');
const { renderMarkdown } = require('../src/markdown');
const { updateTask } = require('../src/taskActions');
const { writeNote, readNote } = require('../src/vault/note');

const toggles = html => [...html.matchAll(/data-task-line="(\d+)"/g)].map(match => Number(match[1]));

test('缩进代码块和 $$ 公式块里的 `- [ ]` 不算待办，阅读页也不渲染成勾选框', () => {
  const body = '格式示例：\n\n    - [ ] 这是代码 @2020-01-01\n\n$$\n- [ ] x\n$$\n\n- [ ] 真待办 @2026-11-01\n';
  assert.deepEqual(extractTasks(body).map(task => [task.line, task.title, task.due]), [[9, '真待办', '2026-11-01']]);
  assert.deepEqual(toggles(renderMarkdown(body, () => '', { taskToggle: true })), [9]);
});

test('落单的反引号不会把后面几段的待办藏起来', () => {
  const body = '键盘左上角的 ` 键。\n\n- [ ] 写周报\n- [ ] 跑实验\n\n最后执行 `ls`。\n';
  assert.deepEqual(extractTasks(body).map(task => task.title), ['写周报', '跑实验']);
  assert.deepEqual(toggles(renderMarkdown(body, () => '', { taskToggle: true })), [3, 4]);
});

test('正文里有单独的 \\r 时，勾选改的就是点的那一行，原来的换行符原样保留', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-task-cr-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const raw = '# 计划\r\n\r\n从 PDF 粘贴的一行\r续行\n\n- [ ] A\r\n- [ ] B\n';
  const note = await writeNote(dir, 'n.md', { raw });
  const lines = toggles(renderMarkdown(note.body, () => '', { taskToggle: true }));
  assert.deepEqual(lines, extractTasks(note.body).map(task => task.line));
  const a = extractTasks(note.body).find(task => task.title === 'A');
  await updateTask(dir, { path: 'n.md', line: a.line, expectedHash: note.hash, done: true });
  assert.equal((await readNote(dir, 'n.md')).raw, raw.replace('- [ ] A', '- [x] A'));
});
