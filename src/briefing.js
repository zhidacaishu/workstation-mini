const { statusLabel } = require('./workflows');

function line(value) {
  return value === null || value === undefined ? '—' : String(value);
}

/**
 * 回顾草稿。
 *
 * 所有数字都从已有模块算出来，**你只需要写反思**。回顾之所以难以坚持，
 * 多半不是因为不想想，而是因为「先把这周干了什么统计一遍」这一步太累。
 */
function renderRetrospective(data, { title = '周回顾' } = {}) {
  const lines = [
    `# ${title} ${data.from} → ${data.to}`,
    '',
    '## 数据',
    '',
    `- 日记：${data.days} 天里写了 ${data.diary.entries} 天`
      + (data.diary.moodAverage !== null ? `，平均情绪 ${data.diary.moodAverage.toFixed(1)}/5` : '')
      + (data.diary.focusMinutes ? `，累计专注 ${(data.diary.focusMinutes / 60).toFixed(1)} 小时` : ''),
    `- 复习：${data.review.count} 次，覆盖 ${data.review.cards} 张卡`
      + (data.review.again ? `，其中 ${data.review.again} 次「忘了」` : ''),
    data.writing
      ? `- 笔记改动：新增 ${data.writing.added} 行、删除 ${data.writing.removed} 行（净 ${data.writing.net >= 0 ? '+' : ''}${data.writing.net}）`
      : '- 笔记改动：vault 不是 git 仓库，无法统计',
    `- 错题：新增 ${data.mistakes.total} 处`
  ];

  if (data.mistakes.top.length) {
    lines.push('', '## 错误集中在哪', '');
    for (const row of data.mistakes.top) {
      lines.push(`- ${row.category}（${row.source === 'writing' ? '写作' : '习题'}）：${row.total} 处`);
    }
  }

  if (data.tasks.staleCount) {
    lines.push('', `## 一直没动的待办（${data.tasks.staleCount} 条）`, '');
    for (const task of data.tasks.stale) {
      lines.push(`- [ ] ${task.title}${task.due ? `（${task.due} 已过）` : ''} —— ${task.noteTitle}`);
    }
    if (data.tasks.staleCount > data.tasks.stale.length) {
      lines.push(`- …另有 ${data.tasks.staleCount - data.tasks.stale.length} 条`);
    }
  }

  lines.push(
    '',
    '## 反思',
    '',
    '### 这段时间真正推进了什么',
    '',
    '',
    '### 卡在哪',
    '',
    '',
    '### 下一段时间的第一件事',
    '',
    ''
  );

  return lines.join('\n');
}

/**
 * 每日简报。与今日首页同一批数据，只是换成适合推送的纯文本。
 */
function renderBriefing(snapshot) {
  const lines = [
    `# ${snapshot.date} ${snapshot.weekday}`,
    ''
  ];

  // 开头一句话把最要紧的说完，剩下的才是细节。
  const headline = [];
  if (snapshot.review.total) {
    headline.push(`要复习 ${snapshot.review.total} 张卡（到期 ${snapshot.review.due}，新卡 ${snapshot.review.fresh}）`);
  }
  if (snapshot.tasks.overdue) headline.push(`${snapshot.tasks.overdue} 条待办已逾期`);
  if (snapshot.tasks.dueToday) headline.push(`${snapshot.tasks.dueToday} 条今天到期`);
  if (!snapshot.diary.writtenToday) headline.push('今天的日记还没写');
  lines.push(headline.length ? `${headline.join('；')}。` : '今天没有到期的东西。', '');

  if (snapshot.diary.plan.length) {
    lines.push('## 今天的计划', '');
    for (const block of snapshot.diary.plan) {
      lines.push(`- ${block.from ? `${block.from}–${block.to} ` : ''}${block.what}`);
    }
    lines.push('');
  }

  if (snapshot.deadlines.length) {
    lines.push('## 临近截止', '');
    for (const entry of snapshot.deadlines) {
      lines.push(`- ${entry.date}${entry.overdue ? '（已过）' : ''} ${entry.label} —— ${entry.detail}`);
    }
    lines.push('');
  }

  if (snapshot.tasks.top.length) {
    lines.push('## 待办', '');
    for (const task of snapshot.tasks.top) {
      lines.push(`- [ ] ${task.title}${task.due ? `（${task.due}）` : ''}`);
    }
    lines.push('');
  }

  const { stuckChapters, runningExperiments, openReviews } = snapshot.attention;
  if (stuckChapters.length || runningExperiments.length || openReviews.length) {
    lines.push('## 需要注意', '');
    for (const item of stuckChapters) lines.push(`- 卡住的章节：${item.title}`);
    for (const item of runningExperiments) lines.push(`- 进行中的实验：${item.title}`);
    for (const item of openReviews) {
      lines.push(`- ${item.title}：还有 ${item.reviewsOpen} 条审稿意见没回应（${statusLabel('submission', item.status)}）`);
    }
    lines.push('');
  }

  if (snapshot.diary.onThisDay.length) {
    lines.push('## 历年今日', '');
    for (const entry of snapshot.diary.onThisDay) {
      lines.push(`- ${entry.label}：${entry.title}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

module.exports = { renderRetrospective, renderBriefing, line };
