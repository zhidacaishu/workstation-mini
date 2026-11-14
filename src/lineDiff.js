// 逐行对比两段文本，给历史页用。Myers 的 O(ND) 算法：两边差得越少算得越快，
// 这正是「旧版本对当前内容」的常见情形。差得太多（超过 MAX_EDITS 行改动）就不比了，
// 调用方退回去显示全文，免得一次误操作的巨型文件把页面拖死。
const MAX_EDITS = 2000;
const CONTEXT_LINES = 3;

function splitLines(text) {
  if (text == null || text === '') return [];
  const lines = String(text).split(/\r\n|\n|\r/);
  // 末尾的换行不算多出来的一行。
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// 返回 [{ type: 'same' | 'del' | 'add', text }]；超过上限返回 null。
function diffLines(fromText, toText, { maxEdits = MAX_EDITS } = {}) {
  const a = splitLines(fromText);
  const b = splitLines(toText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const left = a.slice(head, a.length - tail);
  const right = b.slice(head, b.length - tail);
  const middle = myers(left, right, maxEdits);
  if (!middle) return null;
  return [
    ...a.slice(0, head).map(text => ({ type: 'same', text })),
    ...middle,
    ...a.slice(a.length - tail).map(text => ({ type: 'same', text }))
  ];
}

function myers(a, b, maxEdits) {
  const n = a.length; const m = b.length;
  if (!n) return m > maxEdits ? null : b.map(text => ({ type: 'add', text }));
  if (!m) return n > maxEdits ? null : a.map(text => ({ type: 'del', text }));
  const limit = Math.min(n + m, maxEdits);
  const offset = limit + 1;
  let v = new Int32Array(2 * limit + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return null;
  // 回溯：trace[d] 是第 d 轮开始前的 v，下标 0 对应 k = -d-1。
  const out = [];
  let x = n; let y = m;
  for (let d = found; d > 0; d -= 1) {
    const prev = trace[d];
    const at = k => prev[k + d + 1];
    const k = x - y;
    const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x -= 1; y -= 1; out.push({ type: 'same', text: a[x] }); }
    if (x === prevX) { y -= 1; out.push({ type: 'add', text: b[y] }); }
    else { x -= 1; out.push({ type: 'del', text: a[x] }); }
  }
  while (x > 0 && y > 0) { x -= 1; y -= 1; out.push({ type: 'same', text: a[x] }); }
  return out.reverse();
}

// 把逐行结果收成给人看的片段：改动前后各留 context 行，中间没变的大段折起来。
// 行号是两边各自的行号（fromLine / toLine），没有的一边是 null。
function buildHunks(ops, { context = CONTEXT_LINES } = {}) {
  let fromLine = 0; let toLine = 0;
  const rows = ops.map(op => {
    if (op.type !== 'add') fromLine += 1;
    if (op.type !== 'del') toLine += 1;
    return { type: op.type, text: op.text, fromLine: op.type === 'add' ? null : fromLine, toLine: op.type === 'del' ? null : toLine };
  });
  const keep = new Uint8Array(rows.length);
  rows.forEach((row, index) => {
    if (row.type === 'same') return;
    const end = Math.min(rows.length - 1, index + context);
    for (let i = Math.max(0, index - context); i <= end; i += 1) keep[i] = 1;
  });
  const hunks = [];
  let index = 0;
  while (index < rows.length) {
    const start = index;
    const kept = keep[index];
    while (index < rows.length && keep[index] === kept) index += 1;
    if (kept) hunks.push({ type: 'lines', rows: rows.slice(start, index) });
    else hunks.push({ type: 'skip', count: index - start });
  }
  const added = rows.filter(row => row.type === 'add').length;
  const removed = rows.filter(row => row.type === 'del').length;
  return { hunks, added, removed, changed: added + removed > 0 };
}

function compareText(fromText, toText, options) {
  const ops = diffLines(fromText, toText, options);
  if (!ops) return { tooLarge: true, hunks: [], added: 0, removed: 0, changed: true };
  return { tooLarge: false, ...buildHunks(ops, options) };
}

module.exports = { compareText, diffLines, buildHunks, splitLines, MAX_EDITS };
