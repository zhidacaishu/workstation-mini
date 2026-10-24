const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cards = require('../src/cards');
const review = require('../src/review');
const { Rating } = require('ts-fsrs');

async function makeVault() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-rev-'));
  await fs.mkdir(path.join(dir, 'cards'), { recursive: true });
  await fs.mkdir(path.join(dir, 'reviews'), { recursive: true });
  return dir;
}

function writeLog(vaultDir, filename, events) {
  fsSync.writeFileSync(
    path.join(vaultDir, 'reviews', filename),
    events.map(e => JSON.stringify(e)).join('\n') + '\n',
    'utf8'
  );
}

// ── 卡片解析 ──────────────────────────────────────────

test('同一物理卡组的路径别名不会并发重复 managed 卡片', async () => {
  const vaultDir = await makeVault();
  try {
    const probe = path.join(vaultDir, 'cards', 'Alias.md');
    await fs.writeFile(probe, 'probe');
    const alias = path.join(vaultDir, 'cards', 'alias.md');
    const sameFile = await Promise.all([fs.stat(probe), fs.stat(alias).catch(() => null)])
      .then(([left, right]) => Boolean(right && left.dev === right.dev && left.ino === right.ino));
    await fs.rm(probe);
    if (!sameFile) return;

    await Promise.all([
      cards.appendCard(vaultDir, { deckFile: 'Alias', front: '问题', back: '答案', managedId: 'one' }),
      cards.appendCard(vaultDir, { deckFile: 'alias', front: '问题', back: '答案', managedId: 'one' })
    ]);

    const raw = await fs.readFile(path.join(vaultDir, 'cards', 'Alias.md'), 'utf8');
    assert.equal((raw.match(/^---$/gm) || []).length, 2);
    assert.equal((raw.match(/workstation:annotation-card:v1/g) || []).length, 1);
  } finally {
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});

test('## 标题是正面，到下一个 ## 之前是背面', () => {
  const parsed = cards.parseCardFile('cards/english.md', [
    '---', 'deck: 英语生词', 'type: en-word', '---', '',
    '## heterogeneity', '异质性；个体差异。', '',
    '## endogeneity', '内生性'
  ].join('\n'));

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].front, 'heterogeneity');
  assert.equal(parsed[0].back, '异质性；个体差异。');
  assert.equal(parsed[0].deck, '英语生词');
  assert.equal(parsed[0].type, 'en-word');
  assert.equal(parsed[1].front, 'endogeneity');
});

test('代码块里的 ## 不是卡片分隔符', () => {
  const parsed = cards.parseCardFile('cards/code.md', [
    '## 真卡片',
    '```python',
    '## 这是注释，不是卡片',
    'x = 1',
    '```',
    '正文继续'
  ].join('\n'));

  assert.equal(parsed.length, 1);
  assert.match(parsed[0].back, /这是注释/, '代码块内容应留在背面里');
});

test('{{挖空}} 生成题面与答案面', () => {
  const parsed = cards.parseCardFile('cards/econ.md',
    '## 工具变量的两个条件\n需要满足 {{相关性}} 和 {{外生性}}。');

  assert.equal(parsed[0].type, 'cloze', '含挖空就是挖空卡');
  assert.match(parsed[0].question, /＿＿＿＿/);
  assert.ok(!parsed[0].question.includes('相关性'), '题面不能露答案');
  assert.match(parsed[0].answer, /需要满足 相关性 和 外生性。/);
});

// 卡片 ID 会被永久写进事件日志，必须稳定。
test('卡片 ID 由文件路径和正面文字决定，与行号无关', () => {
  const before = cards.parseCardFile('cards/english.md', '## heterogeneity\n异质性');
  const after = cards.parseCardFile('cards/english.md',
    '## 新插在前面的卡\n内容\n\n## heterogeneity\n异质性');

  const target = after.find(card => card.front === 'heterogeneity');
  assert.equal(before[0].id, 'english/heterogeneity');
  assert.equal(target.id, before[0].id, '前面插了一张卡，ID 不该变');
});

test('同一文件里正面重复时确定性地区分，不抢同一个 ID', () => {
  const parsed = cards.parseCardFile('cards/a.md', '## 重复\n甲\n\n## 重复\n乙');
  assert.equal(parsed[0].id, 'a/重复');
  assert.equal(parsed[1].id, 'a/重复-2');

  // 确定性很关键：两台机器算出的 ID 必须一样，否则事件日志对不上。
  const again = cards.parseCardFile('cards/a.md', '## 重复\n甲\n\n## 重复\n乙');
  assert.deepEqual(again.map(c => c.id), parsed.map(c => c.id));
});

// 加后缀这件事必须避开文件里已经显式存在的名字。只记「加后缀前的名字」的话，
// `## A / ## A / ## A-2` 会让第二个 A 排成 A-2，跟真正的 A-2 撞成同一个 ID ——
// 而 ID 一撞，replay 就把两张卡的复习历史喂进同一个 FSRS 状态机，排期直接算错。
test('后缀不会撞上文件里已经存在的同名标题', () => {
  const parsed = cards.parseCardFile('cards/a.md', '## A\n1\n\n## A\n2\n\n## A-2\n3');
  const ids = parsed.map(card => card.id);
  assert.equal(new Set(ids).size, ids.length, `ID 必须互不相同，实际是 ${JSON.stringify(ids)}`);
  assert.equal(ids[0], 'a/A');
  assert.equal(ids[2], 'a/A-2', '显式写出来的 A-2 应保住它自己的 ID');

  const again = cards.parseCardFile('cards/a.md', '## A\n1\n\n## A\n2\n\n## A-2\n3');
  assert.deepEqual(again.map(card => card.id), ids, '仍然必须是确定性的');
});

test('正面结尾紧贴的 # 属于文字本身，ID 沿用旧算法不让复习历史断档', () => {
  const parsed = cards.parseCardFile('cards/lang.md', '## C#\n语言\n\n## F# 入门 ##\n乙\n\n## 标题 ###\n丙');
  assert.deepEqual(parsed.map(card => card.front), ['C#', 'F# 入门', '标题']);
  // 旧版本把 `## C#` 读成「C」并以 lang/C 记进了复习日志。
  assert.deepEqual(parsed.map(card => card.id), ['lang/C', 'lang/F# 入门', 'lang/标题']);
});

test('背面里的二级标题不会被拆成另一张卡，代码块内原样保留', async () => {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-card-back-'));
  try {
    await cards.appendCard(vaultDir, {
      deckFile: 'inbox',
      front: '这段方法的要点',
      back: '## 方法\n工具变量\n\n```md\n## 代码里的标题\n```\n# 一级标题'
    });
    const loaded = await cards.loadAllCards(vaultDir);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].front, '这段方法的要点');
    assert.match(loaded[0].back, /^### 方法/);
    assert.match(loaded[0].back, /```md\n## 代码里的标题\n```/);
    assert.match(loaded[0].back, /\n# 一级标题$/);
  } finally {
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});

test('背面里没闭合的代码围栏不会吞掉之后追加的卡', async () => {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-card-fence-'));
  try {
    await cards.appendCard(vaultDir, { deckFile: 'd', front: 'Q1', back: '看这段：\n```python\nx = 1' });
    await cards.appendCard(vaultDir, { deckFile: 'd', front: 'Q2', back: 'A2' });
    // 只选到了结束围栏的那一半。
    await cards.appendCard(vaultDir, { deckFile: 'd', front: 'P1', back: 'y = 2\n```\n## 方法\n内容' });
    await cards.appendCard(vaultDir, { deckFile: 'd', front: 'P2', back: 'B2' });

    const loaded = await cards.loadAllCards(vaultDir);
    assert.deepEqual(loaded.map(card => card.front), ['Q1', 'Q2', 'P1', 'P2']);
    assert.equal(loaded[1].back, 'A2');
    assert.equal(loaded[3].back, 'B2');
  } finally {
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});

test('卡组文件名不合法时 appendCard 直接拒绝', async () => {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-deck-'));
  try {
    for (const deckFile of ['con', 'aux', '/etc/passwd', 'a//b', '../escape']) {
      await assert.rejects(
        () => cards.appendCard(vaultDir, { deckFile, front: '正面' }),
        error => error.status === 400 && /卡组文件名不合法/.test(error.message),
        `${deckFile} 应被拒绝`
      );
    }
    // 正常名字不受影响。
    const ok = await cards.appendCard(vaultDir, { deckFile: 'inbox', front: '正面' });
    assert.equal(ok.path, 'cards/inbox.md');
  } finally {
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});

// ── 事件日志 ──────────────────────────────────────────

test('复习事件按「年月 + 设备」分文件写入', async () => {
  const vault = await makeVault();
  try {
    const store = review.createReviewStore({
      vaultDir: vault, device: 'desktop', now: () => new Date(2026, 7, 6, 14, 0)
    });
    await store.record('english/heterogeneity', Rating.Good, 4200, 'event-1');

    const files = await fs.readdir(path.join(vault, 'reviews'));
    assert.deepEqual(files, ['2026-08-desktop.jsonl']);

    const line = JSON.parse(fsSync.readFileSync(path.join(vault, 'reviews', files[0]), 'utf8').trim());
    assert.equal(line.event_id, 'event-1');
    assert.equal(line.card_id, 'english/heterogeneity');
    assert.equal(line.rating, Rating.Good);
    assert.equal(line.elapsed_ms, 4200);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('事件只追加不改写，历史不会被覆盖', async () => {
  const vault = await makeVault();
  try {
    const store = review.createReviewStore({
      vaultDir: vault, device: 'desktop', now: () => new Date(2026, 7, 6, 14, 0)
    });
    await store.record('a', Rating.Good);
    await store.record('b', Rating.Again);
    await store.record('a', Rating.Easy);

    const events = await store.readEvents();
    assert.equal(events.length, 3, '三条都要在');
    assert.deepEqual(events.map(e => e.cardId), ['a', 'b', 'a']);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('相同事件 ID 的重试只追加一次，冲突载荷返回 409', async () => {
  const vault = await makeVault();
  try {
    const store = review.createReviewStore({
      vaultDir: vault, device: 'desktop', now: () => new Date('2026-08-06T14:00:00.000Z')
    });
    const [first, duplicate] = await Promise.all([
      store.record('a', Rating.Good, 4200, 'stable-event'),
      store.record('a', Rating.Good, 4200, 'stable-event')
    ]);
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal((await store.readEvents()).length, 1);
    await assert.rejects(
      store.record('a', Rating.Easy, 4200, 'stable-event'),
      error => error.status === 409
    );
    assert.equal((await store.readEvents()).length, 1);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('重放按稳定事件 ID 去重，旧事件仍各自保留', () => {
  const events = [
    { eventId: 'same', cardId: 'a', ts: '2026-08-01T09:00:00.000Z', rating: Rating.Good, source: 'a.jsonl', line: 0 },
    { eventId: 'same', cardId: 'a', ts: '2026-08-01T09:00:01.000Z', rating: Rating.Good, source: 'b.jsonl', line: 0 },
    { eventId: '', cardId: 'a', ts: '2026-08-01T09:00:02.000Z', rating: Rating.Good, source: 'a.jsonl', line: 1 },
    { eventId: '', cardId: 'a', ts: '2026-08-01T09:00:03.000Z', rating: Rating.Good, source: 'a.jsonl', line: 2 }
  ];
  assert.equal(review.replay(events).get('a').reviewCount, 3);
});

test('坏行被跳过，不让半行 JSON 拖垮整个复习功能', async () => {
  const vault = await makeVault();
  try {
    fsSync.writeFileSync(path.join(vault, 'reviews', '2026-08-desktop.jsonl'), [
      JSON.stringify({ card_id: 'a', ts: '2026-08-06T00:00:00.000Z', rating: 3 }),
      '{"card_id":"半行',                                     // 崩溃留下的残行
      '',                                                     // 空行
      JSON.stringify({ card_id: 'b', ts: '不是时间', rating: 3 }),
      JSON.stringify({ card_id: 'c', ts: '2026-08-06T01:00:00.000Z', rating: 99 }), // 非法评分
      JSON.stringify({ card_id: 'd', ts: '2026-08-06T02:00:00.000Z', rating: 4 })
    ].join('\n'), 'utf8');

    const events = await review.readEvents(vault);
    assert.deepEqual(events.map(e => e.cardId), ['a', 'd'], '只保留合法事件');
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('崩溃留下的半行不会吞掉之后追加的评分', async () => {
  const vault = await makeVault();
  try {
    const logPath = path.join(vault, 'reviews', '2026-09-desktop.jsonl');
    fsSync.writeFileSync(logPath, '{"card_id":"a","ts":"2026-09-01T00:00:00Z","rat', 'utf8');
    const store = review.createReviewStore({
      vaultDir: vault,
      device: 'desktop',
      now: () => new Date('2026-09-02T12:00:00Z')
    });
    await store.record('deck/q', Rating.Good, 100, 'event-1');

    const events = await review.readEvents(vault);
    assert.deepEqual(events.map(e => e.cardId), ['deck/q']);
    assert.match(fsSync.readFileSync(logPath, 'utf8'), /"rat\n\{"event_id":"event-1"/);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

// ── 重放 ──────────────────────────────────────────────

// 这是整个同步方案能成立的核心断言。
test('两台设备交叉复习，重放结果与单设备顺序执行完全一致', async () => {
  const twoDevices = await makeVault();
  const oneDevice = await makeVault();
  try {
    const timeline = [
      { ts: '2026-08-01T09:00:00.000Z', rating: Rating.Good, device: 'desktop' },
      { ts: '2026-08-02T21:00:00.000Z', rating: Rating.Again, device: 'phone' },
      { ts: '2026-08-04T08:00:00.000Z', rating: Rating.Good, device: 'phone' },
      { ts: '2026-08-07T10:00:00.000Z', rating: Rating.Hard, device: 'desktop' },
      { ts: '2026-08-11T22:00:00.000Z', rating: Rating.Easy, device: 'phone' },
      { ts: '2026-08-20T09:00:00.000Z', rating: Rating.Good, device: 'desktop' }
    ].map(e => ({ card_id: 'english/heterogeneity', ts: e.ts, rating: e.rating, device: e.device }));

    // 两设备：各写各的文件，时间上交叉。
    writeLog(twoDevices, '2026-08-desktop.jsonl',
      timeline.filter(e => e.device === 'desktop').map(({ device, ...rest }) => rest));
    writeLog(twoDevices, '2026-08-phone.jsonl',
      timeline.filter(e => e.device === 'phone').map(({ device, ...rest }) => rest));

    // 单设备：同样的事件，同一个文件，顺序执行。
    writeLog(oneDevice, '2026-08-desktop.jsonl',
      timeline.map(({ device, ...rest }) => rest));

    const crossed = await review.replay(await review.readEvents(twoDevices));
    const sequential = await review.replay(await review.readEvents(oneDevice));

    assert.deepEqual(
      crossed.get('english/heterogeneity'),
      sequential.get('english/heterogeneity'),
      '交叉复习必须和顺序复习算出同一个状态，否则不同设备会各算各的'
    );
    assert.equal(crossed.get('english/heterogeneity').reps, 6);
  } finally {
    for (const dir of [twoDevices, oneDevice]) await fs.rm(dir, { recursive: true, force: true });
  }
});

test('时间戳相同的事件排序确定，不依赖文件读取顺序', async () => {
  const vault = await makeVault();
  try {
    const sameMoment = '2026-08-06T12:00:00.000Z';
    writeLog(vault, '2026-08-desktop.jsonl', [{ card_id: 'x', ts: sameMoment, rating: Rating.Again }]);
    writeLog(vault, '2026-08-phone.jsonl', [{ card_id: 'x', ts: sameMoment, rating: Rating.Easy }]);

    // 连跑多次，结果必须完全一致。
    const runs = [];
    for (let i = 0; i < 5; i += 1) {
      runs.push(JSON.stringify((await review.replay(await review.readEvents(vault))).get('x')));
    }
    assert.equal(new Set(runs).size, 1, '同一批事件重放多次必须得到同一结果');
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('重放是纯函数：同样的事件反复重放结果不变', async () => {
  const vault = await makeVault();
  try {
    writeLog(vault, '2026-08-desktop.jsonl', [
      { card_id: 'a', ts: '2026-08-01T09:00:00.000Z', rating: Rating.Good },
      { card_id: 'a', ts: '2026-08-05T09:00:00.000Z', rating: Rating.Good },
      { card_id: 'a', ts: '2026-08-20T09:00:00.000Z', rating: Rating.Easy }
    ]);
    const events = await review.readEvents(vault);
    assert.deepEqual(review.replay(events).get('a'), review.replay(events).get('a'));

    // 打乱输入顺序也不影响结果 —— 重放内部会按全序排好。
    const shuffled = [events[2], events[0], events[1]];
    assert.deepEqual(review.replay(shuffled).get('a'), review.replay(events).get('a'));
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('卡片被删掉后，它的历史事件不会让重放崩掉', async () => {
  const vault = await makeVault();
  try {
    writeLog(vault, '2026-08-desktop.jsonl', [
      { card_id: '还在的卡', ts: '2026-08-01T09:00:00.000Z', rating: Rating.Good },
      { card_id: '已删除的卡', ts: '2026-08-02T09:00:00.000Z', rating: Rating.Good }
    ]);
    const states = review.replay(await review.readEvents(vault), ['还在的卡']);
    assert.equal(states.size, 1);
    assert.ok(states.has('还在的卡'));
    assert.ok(!states.has('已删除的卡'), '已删卡片的历史留在日志里，但不产出状态');
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('FSRS 关闭了间隔扰动，否则两台设备算出的到期日会不一样', () => {
  assert.equal(review.FSRS_PARAMETERS.enable_fuzz, false);
});

test('非法评分被拒绝，不写进日志', async () => {
  const vault = await makeVault();
  try {
    const store = review.createReviewStore({ vaultDir: vault, device: 'desktop' });
    await assert.rejects(store.record('a', 0), /Unknown rating/, 'Manual 不是有效的复习评分');
    await assert.rejects(store.record('a', 99), /Unknown rating/);
    assert.equal((await fs.readdir(path.join(vault, 'reviews'))).length, 0, '不该产生日志文件');
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('卡片正面压成一行，多行内容不会漏进背面', async () => {
  const vault = await makeVault();
  try {
    // 错题转卡片曾经把「下面这句话问题在哪？\n\n<那句话>」整段塞进 front。
    // 卡片格式里正面就是那行 `## 标题`，只有第一行算正面，剩下的会被
    // splitCards 当成背面 —— 于是要考的那句话在翻开答案之前根本看不到。
    await cards.appendCard(vault, {
      deckFile: 'writing-mistakes',
      front: '冗余表达：下面这句话问题在哪？\n\nIt should be noted that the results are significant.',
      back: '删掉 It should be noted that。'
    });

    const raw = await fs.readFile(path.join(vault, 'cards', 'writing-mistakes.md'), 'utf8');
    const parsed = cards.parseCardFile('cards/writing-mistakes.md', raw);

    assert.equal(parsed.length, 1);
    assert.ok(parsed[0].front.includes('It should be noted that'), '要考的句子必须留在正面');
    assert.ok(!parsed[0].front.includes('\n'), '正面只能是一行');
    assert.equal(parsed[0].back, '删掉 It should be noted that。', '背面只放答案');
    // 写进文件的标题和算出来的 ID 要对得上（cardId 也做同样的空白归一）。
    assert.equal(parsed[0].id, cards.cardId('cards/writing-mistakes.md', parsed[0].front));
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});
