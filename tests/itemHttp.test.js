const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { createIndexer } = require('../src/vault/indexer');
const { createSearch } = require('../src/search');
const { writeNote, readNote } = require('../src/vault/note');

const FIXED_NOW = new Date(2026, 2, 17, 14, 30);
const TODAY = '2026-03-17';

async function setup({ readOnly = false } = {}) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-item-http-'));
  const notesDir = path.join(vaultDir, 'notes');
  await fs.mkdir(notesDir, { recursive: true });

  const config = loadConfig({ vaultDir, dbPath: ':memory:', readOnly });

  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: notesDir });
  const search = createSearch(db);
  const app = createApp(config, { db, indexer, search, now: () => FIXED_NOW });

  return {
    app, db, indexer, config, vaultDir, notesDir,
    async cleanup() {
      db.close();
      await fs.rm(vaultDir, { recursive: true, force: true });
    }
  };
}

test('三个看板共用同一个页面模板', async () => {
  const ctx = await setup();
  try {
    for (const key of ['experiment', 'submission', 'chapter']) {
      const response = await request(ctx.app).get(`/board/${key}`).expect(200);
      assert.match(response.text, /boardnav/, '都应有工作流切换导航');
      assert.match(response.text, /还没有/, '空看板应给出建条目的格式说明');
    }
  } finally {
    await ctx.cleanup();
  }
});

test('未知看板返回 404', async () => {
  const ctx = await setup();
  try {
    await request(ctx.app).get('/board/瞎写的').expect(404);
  } finally {
    await ctx.cleanup();
  }
});

test('条目按状态分列，空列也保留', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'experiments/exp-001.md', {
      data: { title: '基线模型', status: 'running', dataset: 'panel-2024' }, body: '正文'
    });
    await writeNote(ctx.notesDir, 'experiments/exp-002.md', {
      data: { title: '稳健性', status: 'planned' }, body: '正文'
    });
    await ctx.indexer.scan();

    const response = await request(ctx.app).get('/board/experiment').expect(200);
    assert.match(response.text, /共 2 个实验/);
    assert.match(response.text, /基线模型/);
    assert.match(response.text, /panel-2024/);
    assert.match(response.text, /已放弃/, '没有条目的那一档也要显示');
    assert.match(response.text, /<div class="board" data-board data-workflow="experiment">/);
    assert.match(response.text, /data-board-column data-status="running"/);
    assert.match(response.text, /data-column-count>1<\/span>/);
    assert.match(response.text, /data-board-card data-path="experiments\/exp-001\.md" data-status="running"/);
    assert.match(response.text, /<div class="board-items" data-board-items>/);
    assert.match(response.text, /class="board-empty" hidden>暂无条目<\/p>/);
    assert.match(response.text, /<form class="statusform" action="\/board\/status" method="post">/);
    assert.match(response.text, /<select name="status" data-auto-submit aria-label="改变状态">/);
  } finally {
    await ctx.cleanup();
  }
});

test('改状态写回 frontmatter，看板随即更新', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'experiments/exp-001.md', {
      data: { title: '基线模型', status: 'planned', seed: 42 }, body: '# 基线\n\n正文保留'
    });
    await ctx.indexer.scan();

    const before = await readNote(ctx.notesDir, 'experiments/exp-001.md');
    await request(ctx.app).post('/board/status').type('form')
      .send({
        workflow: 'experiment',
        path: 'experiments/exp-001.md',
        status: 'done',
        expectedHash: before.hash
      })
      .expect(302);

    const note = await readNote(ctx.notesDir, 'experiments/exp-001.md');
    assert.equal(note.data.status, 'done');
    assert.equal(note.data.seed, 42, '其它字段不能丢');
    assert.match(note.body, /正文保留/);

    const board = await request(ctx.app).get('/board/experiment').expect(200);
    assert.match(board.text, /已完成/);

    // 不带版本的提交要被拒绝，而不是当成「跳过检查」直接写。
    await request(ctx.app).post('/board/status').type('form')
      .send({ workflow: 'experiment', path: 'experiments/exp-001.md', status: 'running' })
      .expect(409);
    assert.equal((await readNote(ctx.notesDir, 'experiments/exp-001.md')).data.status, 'done');
  } finally {
    await ctx.cleanup();
  }
});

test('跨工作流的状态被拒绝', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'experiments/exp-001.md', { data: { status: 'planned' }, body: '正文' });
    await ctx.indexer.scan();

    // accepted 属于投稿流程，不属于实验流程
    const response = await request(ctx.app).post('/board/status')
      .set('Accept', 'application/json')
      .send({ workflow: 'experiment', path: 'experiments/exp-001.md', status: 'accepted' })
      .expect(400);
    assert.match(response.body.message, /合法状态/);

    const note = await readNote(ctx.notesDir, 'experiments/exp-001.md');
    assert.equal(note.data.status, 'planned', '文件不该被改动');
  } finally {
    await ctx.cleanup();
  }
});

test('章节进度条按习题完成度渲染', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'reading/econ/ch03.md', {
      data: { title: '第三章', status: 'exercises', exercises_done: 7, exercises_total: 20 }, body: '正文'
    });
    await ctx.indexer.scan();

    const response = await request(ctx.app).get('/board/chapter').expect(200);
    assert.match(response.text, /width:35%/);
    assert.match(response.text, /7\/20 题/);
  } finally {
    await ctx.cleanup();
  }
});

test('审稿意见的未回应数在看板上标红提示', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'submissions/platform.md', {
      data: {
        title: '平台定价', status: 'major-revision',
        reviews: [
          { id: 'R1.1', comment: '识别策略不清楚', status: 'done', response: '已补充' },
          { id: 'R1.2', comment: '缺少稳健性检验' }
        ]
      },
      body: '正文'
    });
    await ctx.indexer.scan();

    const response = await request(ctx.app).get('/board/submission').expect(200);
    assert.match(response.text, /审稿意见 2 条/);
    assert.match(response.text, /未回应 1/);
    assert.match(response.text, /导出回复稿/);
  } finally {
    await ctx.cleanup();
  }
});

test('导出 response letter 是可下载的 Markdown', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'submissions/platform.md', {
      data: {
        title: '平台定价', status: 'major-revision',
        reviews: [
          { id: 'R1.1', comment: '识别策略不清楚', status: 'done', response: '已在 3.2 节补充' },
          { id: 'R1.2', comment: '缺少稳健性检验' }
        ]
      },
      body: '正文'
    });
    await ctx.indexer.scan();

    const response = await request(ctx.app)
      .get('/submissions/letter?path=' + encodeURIComponent('submissions/platform.md'))
      .expect(200);

    assert.match(response.headers['content-type'], /text\/markdown/);
    assert.match(response.headers['content-disposition'], /response-letter\.md/);
    assert.match(response.text, /## R1\.1/);
    assert.match(response.text, /已在 3\.2 节补充/);
    assert.match(response.text, /（尚未回应）/);
  } finally {
    await ctx.cleanup();
  }
});

test('没录入审稿意见时导出被拒绝，而不是给个空文件', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'submissions/a.md', { data: { status: 'drafting' }, body: '正文' });
    await ctx.indexer.scan();

    await request(ctx.app)
      .get('/submissions/letter?path=' + encodeURIComponent('submissions/a.md'))
      .expect(400);
  } finally {
    await ctx.cleanup();
  }
});

// 任务是派生数据，页面只是换个角度看同一批 Markdown。
test('待办页汇总各篇笔记里的 - [ ]，含日记里顺手记的', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'diary/2026-03-17.md', {
      body: '# 今天\n\n- [ ] 给导师发邮件 @2026-03-20\n- [x] 补描述性统计'
    });
    await writeNote(ctx.notesDir, 'experiments/exp-001.md', {
      data: { status: 'running' }, body: '- [ ] 跑稳健性检验 @2026-03-01'
    });
    await ctx.indexer.scan();

    const response = await request(ctx.app).get('/tasks').expect(200);
    assert.match(response.text, /给导师发邮件/);
    assert.match(response.text, /跑稳健性检验/);
    assert.ok(!response.text.includes('补描述性统计'), '默认只看未完成');

    // 逾期的排最前面
    const overdueIndex = response.text.indexOf('跑稳健性检验');
    const laterIndex = response.text.indexOf('给导师发邮件');
    assert.ok(overdueIndex < laterIndex, '逾期的应排在前面');
    assert.match(response.text, /逾期 2026-03-01/);
  } finally {
    await ctx.cleanup();
  }
});

test('待办可以连已完成一起看', async () => {
  const ctx = await setup();
  try {
    // 任务标题要和页面上的统计标签（未完成／已完成）区分开，
    // 否则断言会撞上 UI 文案而不是真的在测任务列表。
    await writeNote(ctx.notesDir, 'a.md', { body: '- [ ] 还没做的事\n- [x] 做完了的事' });
    await ctx.indexer.scan();

    const open = await request(ctx.app).get('/tasks').expect(200);
    assert.match(open.text, /还没做的事/);
    assert.ok(!open.text.includes('做完了的事'), '默认不列已完成的任务');

    const all = await request(ctx.app).get('/tasks?done=1').expect(200);
    assert.match(all.text, /做完了的事/);
    assert.match(all.text, /is-done/, '已完成的任务应带上删除线样式');
  } finally {
    await ctx.cleanup();
  }
});

test('只读实例能看看板与待办，但不能改状态', async () => {
  const ctx = await setup({ readOnly: true });
  try {
    await writeNote(ctx.notesDir, 'experiments/exp-001.md', { data: { status: 'planned' }, body: '- [ ] 待办' });
    await ctx.indexer.scan();

    await request(ctx.app).get('/board/experiment').expect(200);
    await request(ctx.app).get('/tasks').expect(200);

    await request(ctx.app).post('/board/status').type('form')
      .send({ workflow: 'experiment', path: 'experiments/exp-001.md', status: 'done' })
      .expect(403);

    const note = await readNote(ctx.notesDir, 'experiments/exp-001.md');
    assert.equal(note.data.status, 'planned');

    const board = await request(ctx.app).get('/board/experiment').expect(200);
    assert.ok(!board.text.includes('statusform'), '只读实例不该渲染状态下拉框');
  } finally {
    await ctx.cleanup();
  }
});

test('拒绝越界路径', async () => {
  const ctx = await setup();
  try {
    await request(ctx.app).post('/board/status').set('Accept', 'application/json').type('form')
      .send({ workflow: 'experiment', path: '../escape.md', status: 'done' }).expect(400);
    await request(ctx.app).get('/submissions/letter?path=' + encodeURIComponent('../escape.md')).expect(400);
  } finally {
    await ctx.cleanup();
  }
});
