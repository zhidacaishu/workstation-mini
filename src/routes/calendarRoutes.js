const express = require('express');

const { createAggregator } = require('../aggregate');
const {
  addMonths, isValidDateString, isValidMonthString, monthGridDates, weekdayOf,
  WEEKDAYS_MONDAY_FIRST
} = require('../dates');
const { sortTasks } = require('../tasks');
const { toLocalDate } = require('../templates');
const { readNote, writeNote, deleteNote } = require('../vault/note');
const { enqueueNote } = require('../vault/note-queue');
const { blockWhenReadOnly, httpError } = require('./http');

const FILTERS = new Set(['all', 'overdue', 'today', 'undated', 'deadlines', 'done']);
const notePathFor = date => 'calendar/' + date + '.md';

async function readDay(notesDir, date) {
  try {
    return await readNote(notesDir, notePathFor(date), { tolerateInvalid: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function taskGroup(key, label, tasks = [], projects = []) {
  return { key, label, tasks, projects };
}

function planGroups({ filter, tasks, projects, today }) {
  const open = tasks.filter(task => !task.done);
  const done = tasks.filter(task => task.done);
  const overdue = open.filter(task => task.due && task.due < today);
  const dueToday = open.filter(task => task.due === today);
  const upcoming = open.filter(task => task.due && task.due > today);
  const undated = open.filter(task => !task.due);

  if (filter === 'overdue') return [taskGroup('overdue', '已逾期', sortTasks(overdue, today))];
  if (filter === 'today') return [taskGroup('today', '今天', sortTasks(dueToday, today))];
  if (filter === 'undated') return [taskGroup('undated', '未安排日期', sortTasks(undated, today))];
  if (filter === 'done') return [taskGroup('done', '已完成', sortTasks(done, today))];

  if (filter === 'deadlines') {
    const dated = new Map();
    const add = (date, type, entry) => {
      if (!dated.has(date)) dated.set(date, { tasks: [], projects: [] });
      dated.get(date)[type].push(entry);
    };
    for (const task of open) if (task.due) add(task.due, 'tasks', task);
    for (const project of projects) add(project.date, 'projects', project);
    return [...dated.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, entries]) => (
      taskGroup(date, `${date} ${weekdayOf(date)}`, sortTasks(entries.tasks, today), entries.projects)
    ));
  }

  return [
    taskGroup('overdue', '已逾期', sortTasks(overdue, today)),
    taskGroup('today', '今天', sortTasks(dueToday, today)),
    taskGroup('upcoming', '接下来', sortTasks(upcoming, today)),
    taskGroup('undated', '未安排日期', sortTasks(undated, today))
  ];
}

function createCalendarRoutes({ config, db, indexer, now = () => new Date() }) {
  const router = express.Router();
  const aggregate = createAggregator({ config, db, now });

  async function renderPlan(req, res, { view, filter } = {}) {
    const today = toLocalDate(now());
    const requestedFilter = FILTERS.has(req.query.filter) ? req.query.filter : '';
    const resolvedView = view || (req.query.view === 'calendar' ? 'calendar' : 'list');
    const resolvedFilter = filter || requestedFilter || (req.query.done === '1' ? 'done' : 'all');
    const requestedDate = isValidDateString(req.query.date) ? req.query.date : '';
    const month = isValidMonthString(req.query.month)
      ? req.query.month : (requestedDate || today).slice(0, 7);
    const weeks = monthGridDates(month);
    const from = weeks[0][0];
    const to = weeks[weeks.length - 1][6];
    const selected = requestedDate && requestedDate >= from && requestedDate <= to
      ? requestedDate : today.startsWith(month) ? today : month + '-01';
    const notes = new Map(await Promise.all((resolvedView === 'calendar' ? weeks.flat() : []).map(async date => (
      [date, await readDay(config.notesDir, date)]
    ))));

    const allTasks = db.listTasks({ includeDone: true });
    const openTasks = allTasks.filter(task => !task.done);
    const projectEntries = aggregate.datedEntries(today).filter(entry => entry.source === '研究项目');
    const projects = projectEntries.map(entry => ({
      path: entry.path,
      label: entry.label,
      date: entry.date,
      overdue: entry.overdue,
      kind: 'project',
      source: entry.source
    }));
    const entriesByDate = new Map();
    for (const entry of aggregate.datedEntriesInRange(from, to, today)) {
      const kind = entry.source === '研究项目' ? 'project' : 'task';
      const planEntry = { ...entry, kind };
      if (!entriesByDate.has(entry.date)) entriesByDate.set(entry.date, []);
      entriesByDate.get(entry.date).push(planEntry);
    }

    const overdue = openTasks.filter(task => task.due && task.due < today);
    const dueToday = openTasks.filter(task => task.due === today);
    const undated = openTasks.filter(task => !task.due);

    res.render('plan', {
      title: '计划',
      view: resolvedView,
      filter: resolvedFilter,
      today,
      month,
      selected,
      selectedWeekday: weekdayOf(selected),
      weeks,
      weekdays: WEEKDAYS_MONDAY_FIRST,
      notes,
      entriesByDate,
      previousMonth: addMonths(month, -1),
      nextMonth: addMonths(month, 1),
      selectedNote: notes.get(selected),
      selectedPath: notePathFor(selected),
      selectedTasks: openTasks.filter(task => task.due === selected),
      selectedProjects: projects.filter(project => project.date === selected),
      undatedCount: undated.length,
      counts: {
        all: openTasks.length,
        overdue: overdue.length,
        today: dueToday.length,
        undated: undated.length,
        deadlines: openTasks.filter(task => task.due).length + projects.length,
        done: allTasks.filter(task => task.done).length
      },
      groups: planGroups({ filter: resolvedFilter, tasks: allTasks, projects, today })
    });
  }

  router.get('/plan', (req, res, next) => {
    renderPlan(req, res).catch(next);
  });

  // 保留旧入口：已有书签和笔记里的链接仍直接得到同一页，而不是一次重定向。
  router.get('/tasks', (req, res, next) => {
    renderPlan(req, res, { view: 'list' }).catch(next);
  });
  router.get('/calendar', (req, res, next) => {
    renderPlan(req, res, { view: 'calendar' }).catch(next);
  });
  router.get('/deadlines', (req, res, next) => {
    renderPlan(req, res, { view: 'list', filter: 'deadlines' }).catch(next);
  });

  const saveCalendarNote = async (req, res, next) => {
    try {
      const date = String(req.body.date || '');
      if (!isValidDateString(date)) throw httpError(400, '请选择有效日期。');
      const text = String(req.body.text ?? '');
      const expectedHash = String(req.body.expectedHash || '');
      const notePath = notePathFor(date);
      const hash = await enqueueNote(config.notesDir, notePath, async () => {
        const existing = await readDay(config.notesDir, date);
        if (existing?.parseError) throw httpError(409, '备注格式有误，请先在笔记编辑器中修复。');
        if ((existing?.hash || '') !== expectedHash) {
          throw httpError(409, '这天的备注已在其他地方修改，请刷新后合并更改。');
        }
        if (!text.trim()) {
          if (existing) await deleteNote(config.notesDir, notePath);
          return '';
        }
        // 只替换正文，保留从普通笔记编辑器添加的 frontmatter。
        const content = existing
          ? { raw: existing.raw.slice(0, existing.raw.length - existing.body.length) + text }
          : { data: { title: date + ' 月历备注' }, body: text };
        const written = await writeNote(config.notesDir, notePath, content, { exclusive: !existing });
        return written.hash;
      });
      await indexer.scan({ paths: [notePath] });
      if ((req.get('accept') || '').includes('application/json')) {
        res.json({ ok: true, hash });
      } else {
        const month = isValidMonthString(req.body.month) ? req.body.month : date.slice(0, 7);
        res.redirect('/plan?view=calendar&month=' + month + '&date=' + date);
      }
    } catch (error) { next(error); }
  };

  router.post(['/plan/notes', '/calendar/notes'], blockWhenReadOnly(config, '不能修改月历备注。'), saveCalendarNote);

  return router;
}

module.exports = { createCalendarRoutes };
