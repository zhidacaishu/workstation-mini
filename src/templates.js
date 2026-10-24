const fs = require('node:fs');
const path = require('node:path');

// 内置模板只是兜底。vault 里放 templates/<名字>.md 就会覆盖它 ——
// 模板属于个人习惯，应该跟着笔记一起同步，而不是烧在代码里。
const BUILTIN = {
  note: `---
title: {{title}}
tags: []
---

# {{title}}
`
};

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 本地时区的 YYYY-MM-DD。
 *
 * 使用本地时间而不是 UTC，避免在东八区凌晨落到前一天。
 */
function toLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function templateVariables(dateString, extra = {}) {
  const [year, month, day] = dateString.split('-');
  // 按本地时间构造，避免 new Date('2026-08-06') 被当成 UTC 午夜而偏一天。
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return {
    date: dateString,
    year,
    month,
    day,
    weekday: WEEKDAYS[date.getDay()],
    ...extra
  };
}

function renderTemplate(text, variables) {
  return String(text ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key] ?? '') : match
  ));
}

/**
 * 读模板。vault 的 templates/<name>.md 优先，没有就用内置的。
 */
function loadTemplate(vaultDir, name) {
  const custom = path.join(vaultDir, 'templates', `${name}.md`);
  try {
    return { text: fs.readFileSync(custom, 'utf8'), source: 'vault' };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { text: BUILTIN[name] || BUILTIN.note, source: 'builtin' };
}

function renderNamedTemplate(vaultDir, name, variables) {
  return renderTemplate(loadTemplate(vaultDir, name).text, variables);
}

module.exports = {
  BUILTIN,
  WEEKDAYS,
  toLocalDate,
  templateVariables,
  renderTemplate,
  loadTemplate,
  renderNamedTemplate
};
