const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { parseReport, checkDraft, isAvailable } = require('../src/checkDraft');
const mistakes = require('../src/mistakes');

const CHECKER = process.env.WORKSTATION_TEST_CHECK_DRAFT || '';

async function makeVault() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ws-mis-'));
}

// 取自 check_draft.py 的真实输出。
const SAMPLE_REPORT = [
  '',
  '='.repeat(62),
  '必改',
  '='.repeat(62),
  '',
  '[长破折号]  1 处',
  '  L11: …conducted a series of experiments —— the results are shown in Table…',
  '',
  '[英美拼写混用]  1 处',
  '  behavior×1 / behaviour×1  → INFORMS 系用美式',
  '',
  '='.repeat(62),
  '需人工判断',
  '='.repeat(62),
  '',
  '[声称强度]  2 处',
  '  L4: …a novel framework which is superior to existing approaches…  → 无条件断言，改为限定范围的说法',
  '  L5: …our method performs well in general…  → 声称范围可能超过实验覆盖范围',
  '',
  '注：脚本只覆盖机械层面。'
].join('\n');

test('解析检查器输出：分级、类别、行号与建议', () => {
  const findings = parseReport(SAMPLE_REPORT);

  assert.equal(findings.length, 3);

  const dash = findings.find(f => f.category === '长破折号');
  assert.equal(dash.tier, 'hard');
  assert.equal(dash.count, 1);
  assert.equal(dash.instances[0].line, 11);
  assert.match(dash.instances[0].detail, /series of experiments/);

  const spelling = findings.find(f => f.category === '英美拼写混用');
  assert.equal(spelling.instances[0].line, null, '这类没有行号');
  assert.equal(spelling.instances[0].note, 'INFORMS 系用美式');

  const claim = findings.find(f => f.category === '声称强度');
  assert.equal(claim.tier, 'soft', '声称强度属于人工复核项');
  assert.equal(claim.instances.length, 2);
  assert.equal(claim.instances[0].note, '无条件断言，改为限定范围的说法');
});

test('结尾的「注：」不会被当成一条错误实例', () => {
  const findings = parseReport(SAMPLE_REPORT);
  const all = findings.flatMap(f => f.instances.map(i => i.detail));
  assert.ok(!all.some(detail => detail.startsWith('注：')));
});

// 这是接检查器最关键的一个坑。
test('每类超过 25 条时，以表头计数为准而不是数实例行', () => {
  const truncated = [
    '='.repeat(62), '必改', '='.repeat(62),
    '',
    '[全角标点残留]  30 处',
    ...Array.from({ length: 25 }, (_, i) => `  L${i + 3}: …full-width comma。 Number ${i}…`),
    '  ... 另有 5 处，同类问题'
  ].join('\n');

  const [finding] = parseReport(truncated);
  assert.equal(finding.count, 30, '真实数量取自表头');
  assert.equal(finding.instances.length, 25, '输出只列了 25 条');
  assert.equal(finding.truncated, 5, '被截掉的部分要单独记下来');

  // 只数实例行的话会少算 5 处 —— 而且恰恰是你犯得最多的类别被低估。
  assert.notEqual(finding.instances.length, finding.count);
});

test('干净稿件解析出零条问题', () => {
  assert.deepEqual(parseReport('未发现机械层面的问题。结构与论证仍需人工判断。'), []);
  assert.deepEqual(parseReport(''), []);
});

// ── 落库与去重 ────────────────────────────────────────

test('同一份稿件重复检查不会把统计冲爆', async () => {
  const vault = await makeVault();
  try {
    const store = mistakes.createMistakeStore({
      vaultDir: vault, device: 'desktop', now: () => new Date(2026, 7, 6, 10, 0)
    });
    const findings = parseReport(SAMPLE_REPORT);

    store.recordCheck('research/draft.md', findings);
    store.recordCheck('research/draft.md', findings);
    store.recordCheck('research/draft.md', findings);

    const all = await store.all();
    assert.equal(all.length, 4, '三次检查、同样的问题，去重后仍是 4 条');
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('落库后统计数量与检查器表头一致，不因截断而少算', async () => {
  const vault = await makeVault();
  try {
    const store = mistakes.createMistakeStore({
      vaultDir: vault, device: 'desktop', now: () => new Date(2026, 7, 6, 10, 0)
    });
    store.recordCheck('a.md', [{
      tier: 'hard', category: '全角标点残留', count: 30, truncated: 5,
      instances: Array.from({ length: 25 }, (_, i) => ({ line: i + 1, detail: `第 ${i} 处`, note: '' }))
    }]);

    const cluster = mistakes.clusterByCategory(await store.all());
    assert.equal(cluster.length, 1);
    assert.equal(cluster[0].total, 30, '25 条实例 + 被截掉的 5 处 = 30');
    assert.equal(cluster[0].truncated, 5);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('错误记录按「年月 + 设备」分文件，与复习日志同一套路数', async () => {
  const vault = await makeVault();
  try {
    const store = mistakes.createMistakeStore({
      vaultDir: vault, device: 'laptop', now: () => new Date(2026, 7, 6, 10, 0)
    });
    store.recordExercise({ subject: '计量教材 ch03', category: '工具变量', reason: 'concept', detail: '搞混了两个条件' });

    assert.deepEqual(
      fsSync.readdirSync(path.join(vault, 'mistakes', 'exercise')),
      ['2026-08-laptop.jsonl']
    );
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('坏行被跳过，不让半行 JSON 拖垮整个错题本', async () => {
  const vault = await makeVault();
  try {
    const dir = path.join(vault, 'mistakes', 'writing');
    fsSync.mkdirSync(dir, { recursive: true });
    fsSync.writeFileSync(path.join(dir, '2026-08-desktop.jsonl'), [
      JSON.stringify({ id: 'a', source: 'writing', category: '长破折号', ts: '2026-08-06T00:00:00.000Z', count: 1 }),
      '{"id":"半行',
      '',
      JSON.stringify({ id: 'b', source: 'writing', category: '', ts: '2026-08-06T00:00:00.000Z' }),
      JSON.stringify({ id: 'c', source: 'writing', category: '声称强度', ts: '2026-08-06T01:00:00.000Z', count: 1 })
    ].join('\n'), 'utf8');

    const all = await mistakes.readMistakes(vault);
    assert.deepEqual(all.map(r => r.id), ['a', 'c']);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('追加错题记录时隔离末尾坏行，并保留没有换行的完整记录', async () => {
  const vault = await makeVault();
  try {
    const store = mistakes.createMistakeStore({
      vaultDir: vault, device: 'desktop', now: () => new Date(2026, 7, 6, 10, 0)
    });
    for (const source of ['writing', 'exercise']) {
      const dir = path.join(vault, 'mistakes', source);
      await fs.mkdir(dir, { recursive: true });
      const previous = { id: `old-${source}`, source, category: '旧记录', ts: '2026-08-06T00:00:00.000Z' };
      const file = path.join(dir, '2026-08-desktop.jsonl');
      for (const suffix of ['', '\n{"id":"半行']) {
        const original = JSON.stringify(previous) + suffix;
        await fs.writeFile(file, original);
        const saved = source === 'writing'
          ? store.recordCheck('draft.md', parseReport(SAMPLE_REPORT))
          : [store.recordExercise({ category: '新习题' })];
        const records = (await store.all()).filter(record => record.source === source);
        assert.deepEqual(new Set(records.map(record => record.id)), new Set([previous.id, ...saved.map(record => record.id)]));
        assert.ok((await fs.readFile(file, 'utf8')).startsWith(original + '\n'));
      }
    }
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

// ── 写作与习题共用同一套模型 ──────────────────────────

test('写作错题与习题错题走同一套统计，不是两套代码', async () => {
  const vault = await makeVault();
  try {
    const store = mistakes.createMistakeStore({
      vaultDir: vault, device: 'desktop', now: () => new Date(2026, 7, 6, 10, 0)
    });
    store.recordCheck('draft.md', parseReport(SAMPLE_REPORT));
    store.recordExercise({ subject: '计量 ch03', category: '工具变量', reason: 'concept', detail: '条件记混' });
    store.recordExercise({ subject: '计量 ch04', category: '工具变量', reason: 'concept', detail: '又记混了' });

    const cluster = mistakes.clusterByCategory(await store.all());
    const exercise = cluster.filter(c => c.source === 'exercise');
    const writing = cluster.filter(c => c.source === 'writing');

    assert.equal(exercise.length, 1);
    assert.equal(exercise[0].total, 2, '同一题型犯两次，正是要抓的模式');
    assert.equal(writing.length, 3);

    // 排序按次数降序 —— 犯得最多的排最前面。
    assert.ok(cluster[0].total >= cluster[cluster.length - 1].total);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('习题错题必须有题型', async () => {
  const vault = await makeVault();
  try {
    const store = mistakes.createMistakeStore({ vaultDir: vault, device: 'desktop' });
    assert.throws(() => store.recordExercise({ subject: 'x', category: '  ' }), /题型不能为空/);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('按月趋势用于看某类错误是否在减少', () => {
  // 记录里的 ts 是 UTC 瞬时，但分桶要按**本地月** —— 日志文件名用的就是本地日，
  // 两边口径必须一致。所以这条钉死时区跑：不钉的话，在 UTC-7 的机器上一个
  // 「UTC 月初午夜」的时间戳本地还在上个月，测出来的是另一回事。
  const script = `
    const mistakes = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'mistakes'))});
    console.log(JSON.stringify({
      trend: mistakes.monthlyTrend([
        { ts: '2026-06-01T04:00:00.000Z', count: 5 },
        { ts: '2026-06-15T04:00:00.000Z', count: 3 },
        { ts: '2026-07-01T04:00:00.000Z', count: 4 },
        { ts: '2026-08-01T04:00:00.000Z', count: 1 }
      ]),
      // 本地 2026-08-01 07:30，UTC 还是 07-31。必须落进 08。
      crossMonth: mistakes.monthlyTrend([{ ts: '2026-07-31T23:30:00.000Z', count: 1 }])
    }));
  `;
  const output = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'Asia/Shanghai' }
  });
  const seen = JSON.parse(output);

  assert.deepEqual(seen.trend, [
    { month: '2026-06', total: 8 },
    { month: '2026-07', total: 4 },
    { month: '2026-08', total: 1 }
  ]);
  assert.deepEqual(seen.crossMonth, [{ month: '2026-08', total: 1 }], '跨月的那一条要按本地月落格');
});

// ── 真正跑一次检查器 ──────────────────────────────────

test('检查器进程只把约定的 0、1、2 退出码视为有效报告', async () => {
  const vault = await makeVault();
  try {
    const script = path.join(vault, 'checker.cjs');
    for (const code of [0, 1, 2, 3, 4]) {
      const report = code === 1 || code === 2 ? SAMPLE_REPORT : '';
      await fs.writeFile(script, `process.stdout.write(${JSON.stringify(report)}); process.exit(${code});`);
      const result = await checkDraft(script, path.join(vault, 'draft.md'), { python: process.execPath });
      assert.equal(result.available, true);
      assert.equal(result.ok, code <= 2, `退出码 ${code} 不应被误判`);
      if (code <= 2) {
        assert.equal(result.exitCode, code);
        assert.deepEqual(result.findings, parseReport(report));
      } else {
        assert.ok(result.reason);
      }
    }
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('检查器不可用时优雅降级，不抛错', async () => {
  const result = await checkDraft('/nonexistent/check_draft.py', '/tmp/x.md');
  assert.equal(result.available, false);
  assert.match(result.reason, /找不到检查器/);
  assert.equal(isAvailable('/nonexistent/check_draft.py'), false);
});

test('对真实稿件跑真实检查器', { skip: !isAvailable(CHECKER) && '本机没有 academic-writing' }, async () => {
  const vault = await makeVault();
  try {
    const draft = path.join(vault, 'draft.md');
    await fs.writeFile(draft, [
      '# Introduction', '',
      'Our method is superior to existing approaches。 The behaviour and',
      'the behavior of users differ in general.'
    ].join('\n'), 'utf8');

    const result = await checkDraft(CHECKER, draft);
    assert.equal(result.available, true);
    assert.equal(result.ok, true);
    assert.ok(result.findings.length > 0, '这段文字确实有问题');

    const categories = result.findings.map(f => f.category);
    assert.ok(categories.includes('全角标点残留'), `应抓到全角句号，实际：${categories}`);
    assert.ok(result.hardCount > 0, '必改项计数应大于 0');
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('干净稿件跑检查器返回零问题', { skip: !isAvailable(CHECKER) && '本机没有 academic-writing' }, async () => {
  const vault = await makeVault();
  try {
    const draft = path.join(vault, 'clean.md');
    await fs.writeFile(draft, '# Title\n\nThis sentence is clean and unremarkable.\n', 'utf8');

    const result = await checkDraft(CHECKER, draft);
    assert.equal(result.ok, true);
    assert.equal(result.findings.length, 0);
    assert.equal(result.hardCount, 0);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});
