const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createReviewService } = require('../src/reviewService');
const { toLocalDate } = require('../src/templates');
const { addDays } = require('../src/dates');

const SRC_DIR = path.join(__dirname, '..', 'src');

const DECK = [
  '---',
  'deck: 计量',
  '---',
  '',
  '## 工具变量',
  '相关性 + 外生性。',
  '',
  '## 固定效应',
  '组内变异。',
  '',
  '## 双重差分',
  '平行趋势假定。'
].join('\n');

async function makeVault({ events = [] } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-forecast-'));
  await fs.mkdir(path.join(dir, 'cards'), { recursive: true });
  await fs.mkdir(path.join(dir, 'reviews'), { recursive: true });
  await fs.writeFile(path.join(dir, 'cards', 'econ.md'), DECK, 'utf8');
  if (events.length) {
    await fs.writeFile(
      path.join(dir, 'reviews', '2026-08-desktop.jsonl'),
      events.map(event => JSON.stringify(event)).join('\n') + '\n',
      'utf8'
    );
  }
  return dir;
}

function serviceAt(vaultDir, moment) {
  return createReviewService({ vaultDir, device: 'desktop', now: () => moment });
}

test('新卡不占未来的任何一天，单独报一个数', async () => {
  const vaultDir = await makeVault();
  try {
    const service = serviceAt(vaultDir, new Date(2026, 7, 10, 9, 0));
    const result = await service.forecast({ days: 14 });

    assert.equal(result.fresh, 3, '三张卡都还没复习过');
    assert.equal(result.scheduled, 0, '新卡没有排期，不该占格子');
    assert.equal(result.backlog, 0);
    assert.equal(result.days.length, 14);
    assert.ok(result.days.every(day => day.count === 0));
  } finally {
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});

test('每天都有一格，没卡的那天是 0 而不是缺一格', async () => {
  const vaultDir = await makeVault();
  try {
    const service = serviceAt(vaultDir, new Date(2026, 7, 10, 9, 0));
    const result = await service.forecast({ from: '2026-08-10', days: 5 });

    assert.deepEqual(result.days.map(day => day.date), [
      '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'
    ]);
    assert.equal(result.from, '2026-08-10');
    assert.equal(result.to, '2026-08-14');
  } finally {
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});

test('已排期的卡落在 due 所属的本地日，总数对得上', async () => {
  const vaultDir = await makeVault({
    events: [
      { card_id: 'econ/工具变量', ts: '2026-08-10T02:00:00.000Z', rating: 3, elapsed_ms: 1000 },
      { card_id: 'econ/固定效应', ts: '2026-08-10T02:05:00.000Z', rating: 4, elapsed_ms: 1000 }
    ]
  });
  try {
    const moment = new Date(2026, 7, 10, 12, 0);
    const service = serviceAt(vaultDir, moment);

    // 不硬编码 FSRS 的间隔：先问出真实的 due，再断言预测把它放对了格子。
    const states = await service.withStates();
    const scheduled = states.filter(card => card.state.lastReview);
    assert.equal(scheduled.length, 2, '两张卡有复习历史');

    // 窗口锚在最早的那个 due 日，并把 today 也设成它 —— 这条测试只想验证
    // 「每张卡落在自己 due 所属的本地日」，不想被积压归并的逻辑干扰。
    // （学习阶段的 due 只比复习时刻晚几分钟，在负偏移时区可能落到前一个本地日。）
    const from = scheduled.map(card => toLocalDate(new Date(card.state.due))).sort()[0];
    const result = await service.forecast({ from, days: 400, today: from });
    const byDate = new Map(result.days.map(day => [day.date, day.count]));

    for (const card of scheduled) {
      const expected = toLocalDate(new Date(card.state.due));
      assert.ok(byDate.has(expected), `${card.id} 的 due ${expected} 应落在预测窗口内`);
      assert.ok(byDate.get(expected) >= 1, `${expected} 那格应至少有一张卡`);
    }

    assert.equal(result.scheduled, 2);
    assert.equal(result.fresh, 1, '第三张卡没复习过，仍是新卡');
    assert.equal(result.backlog, 0);
  } finally {
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});

test('逾期的卡堆到今天那一格，不留在过去', async () => {
  const vaultDir = await makeVault({
    events: [
      { card_id: 'econ/工具变量', ts: '2026-08-01T02:00:00.000Z', rating: 3, elapsed_ms: 1000 },
      { card_id: 'econ/固定效应', ts: '2026-08-01T02:05:00.000Z', rating: 1, elapsed_ms: 1000 }
    ]
  });
  try {
    // 复习完过了大半年，两张卡无论间隔多长都早就逾期了。
    const moment = new Date(2027, 5, 1, 9, 0);
    const today = toLocalDate(moment);
    const service = serviceAt(vaultDir, moment);
    const result = await service.forecast({ from: today, days: 30 });

    assert.equal(result.backlog, 2, '两张都逾期');
    assert.equal(result.days[0].date, today);
    assert.equal(result.days[0].count, 2, '积压堆在今天，而不是散在过去看不见');
    assert.ok(result.days.slice(1).every(day => day.count === 0));
    assert.equal(result.peak, 2);
  } finally {
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});

test('窗口从今天之后开始时，逾期只计数不落格', async () => {
  const vaultDir = await makeVault({
    events: [{ card_id: 'econ/工具变量', ts: '2026-08-01T02:00:00.000Z', rating: 3, elapsed_ms: 1000 }]
  });
  try {
    const moment = new Date(2027, 5, 1, 9, 0);
    const today = toLocalDate(moment);
    const service = serviceAt(vaultDir, moment);
    // 日历翻到下个月：窗口整段都在今天之后，积压不该凭空塞进某个未来格子。
    const result = await service.forecast({ from: addDays(today, 40), days: 30, today });

    assert.equal(result.backlog, 1, '仍然如实报告积压张数');
    assert.equal(result.scheduled, 0, '但不占这段窗口里的任何一格');
  } finally {
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});

// FSRS 的 due 是 UTC 瞬时。按 UTC 切片分桶的话，东八区晚上到期的卡会被算到前一天，
// 日历上就会在错误的格子里显示复习量。上面的测试在 UTC 机器上跑时两种算法结果相同，
// 证明不了任何事 —— 这里把时区钉死成东八区来验证分歧。
test('东八区：due 按本地日分桶，不是 UTC 日', async () => {
  const vaultDir = await makeVault({
    // 16:30Z 是东八区的次日 00:30。FSRS 的 due 会保留这个时刻，
    // 于是「UTC 日」和「本地日」必然差一天。
    events: [{ card_id: 'econ/工具变量', ts: '2026-08-10T16:30:00.000Z', rating: 3, elapsed_ms: 1000 }]
  });
  try {
    const script = `
      const { createReviewService } = require(${JSON.stringify(path.join(SRC_DIR, 'reviewService'))});
      const { toLocalDate } = require(${JSON.stringify(path.join(SRC_DIR, 'templates'))});

      (async () => {
        const service = createReviewService({
          vaultDir: ${JSON.stringify(vaultDir)},
          device: 'desktop',
          now: () => new Date('2026-08-10T17:00:00.000Z')
        });
        const states = await service.withStates();
        const card = states.find(entry => entry.id === 'econ/工具变量');
        const result = await service.forecast({ from: '2026-08-10', days: 400 });
        const byDate = new Map(result.days.map(day => [day.date, day.count]));

        console.log(JSON.stringify({
          due: card.state.due,
          utcDay: card.state.due.slice(0, 10),
          localDay: toLocalDate(new Date(card.state.due)),
          countOnLocalDay: byDate.get(toLocalDate(new Date(card.state.due))),
          countOnUtcDay: byDate.get(card.state.due.slice(0, 10))
        }));
      })();
    `;
    const output = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, TZ: 'Asia/Shanghai' }
    });
    const seen = JSON.parse(output);

    assert.notEqual(seen.localDay, seen.utcDay, '两者必须不同，否则这条测试证明不了任何事');
    assert.equal(seen.countOnLocalDay, 1, '卡该落在本地日那一格');
    assert.equal(seen.countOnUtcDay, 0, 'UTC 日那一格必须是空的');
  } finally {
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});
