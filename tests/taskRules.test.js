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

test('改期和清空日期只改第一行可写的真实标记，其他 Markdown 原样保留', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-task-dates-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const protectedText = '[日程](https://example.org/@2026-11-19) `@2026-11-19` $x@2026-11-19$ [[档案@2026-11-19]] @2026-02-31';
  const raw = '- [ ] ' + protectedText + ' @2026-11-19 @2026-12-01\r\n  续行 @2026-12-02\r\n';
  const note = await writeNote(dir, 'task.md', { raw });
  assert.equal(extractTasks(raw)[0].due, '2026-11-19');
  assert.equal(extractTasks('- [ ] 讲解 `[[` @2026-11-19 `]]`')[0].due, '2026-11-19');
  assert.doesNotMatch(renderMarkdown(raw), /datetime="2026-02-31"/);
  const result = await updateTask(dir, { path: 'task.md', line: 1, expectedHash: note.hash, due: '2027-01-10' });
  assert.equal((await readNote(dir, 'task.md')).raw, raw.replace(' @2026-11-19 @', ' @2027-01-10 @'));
  const cleared = await updateTask(dir, { path: 'task.md', line: 1, expectedHash: result.hash, due: '' });
  const expected = raw.replace(' @2026-11-19 @2026-12-01\r', '  \r');
  assert.equal((await readNote(dir, 'task.md')).raw, expected);
  await updateTask(dir, { path: 'task.md', line: 1, expectedHash: cleared.hash, done: true, due: '' });
  assert.equal((await readNote(dir, 'task.md')).raw, expected.replace('[ ]', '[x]'));
  for (const source of ['- [ ] example.org/@2026-11-19', '- [ ] `跨行 @2026-11-19\n  结束` @2026-11-20']) {
    assert.equal(extractTasks(source)[0].due, null);
  }
});
