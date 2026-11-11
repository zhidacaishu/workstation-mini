const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');

const run = promisify(execFile);

/**
 * 上手清单。
 *
 * 每一步都只看资料库里实际存在的东西：笔记、待办、卡片和复习记录都是用户自己
 * 写下的，应用不为「完成了哪一步」另存一份状态。在别的设备上写过笔记、或者
 * 打开的是一个用了很久的资料库，这里同样直接算完成，不会让老用户再走一遍。
 *
 * 顺序就是第一天的使用顺序：先有笔记，才谈得上待办和划词建卡；先有卡片，
 * 才谈得上复习。Git 是可选项，不计入进度，只在上手指南页出现。
 */
const CORE_STEPS = ['note', 'task', 'card', 'review'];

// 月历备注也是笔记文件，但它是计划页顺手写的，不算「写下第一篇笔记」。
const isKnowledgeNote = notePath => !notePath.startsWith('calendar/');

async function onboardingProgress({ db, review, recent = [] }) {
  const done = {
    note: db.listPaths().some(isKnowledgeNote),
    task: db.listTasks({ includeDone: true }).length > 0,
    card: (await review.allCards()).length > 0,
    // 复习事件按设备分文件追加；有任何一条就说明完整走过一次复习。
    review: (await review.store.readEvents()).length > 0
  };
  const steps = CORE_STEPS.map(id => ({ id, done: done[id] }));
  const completed = steps.filter(step => step.done).length;
  const latest = recent.find(item => item && isKnowledgeNote(item.path));
  return {
    steps,
    done: completed,
    total: steps.length,
    complete: completed === steps.length,
    next: steps.find(step => !step.done)?.id || '',
    // 建卡要在笔记阅读页划词，直接给一篇最近的笔记作入口。
    latestNote: latest ? { path: latest.path, title: latest.title || latest.path } : null
  };
}

/**
 * Git 版本记录的准备情况，供上手指南逐项显示「已就绪 / 还差什么」。
 *
 * 全部是只读探测：不初始化仓库、不改配置，GIT_OPTIONAL_LOCKS=0 避免和后台
 * 同步抢 index.lock。探测失败一律按「没有」处理，页面照常渲染。
 */
async function gitSetupStatus({ vaultDir, syncEnabled, readOnly, timeoutMs = 1500 }) {
  const git = async args => (await run('git', ['-C', vaultDir, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  })).stdout.trim();
  const status = {
    installed: false,
    isRepository: false,
    hasIdentity: false,
    hasRemote: false,
    syncEnabled: Boolean(syncEnabled),
    readOnly: Boolean(readOnly)
  };
  try {
    await git(['--version']);
    status.installed = true;
  } catch {
    return finishGitStatus(status);
  }
  const [topLevel, name, email, remotes] = await Promise.all([
    git(['rev-parse', '--show-toplevel']).catch(() => ''),
    // 不加 --local：全局配置里的提交身份同样有效。
    git(['config', 'user.name']).catch(() => ''),
    git(['config', 'user.email']).catch(() => ''),
    git(['remote']).catch(() => '')
  ]);
  if (topLevel) {
    try {
      const [root, vault] = await Promise.all([fs.realpath(topLevel), fs.realpath(vaultDir)]);
      status.isRepository = path.relative(root, vault) === '';
    } catch { /* 路径不可用时沿用未就绪状态。 */ }
  }
  status.hasIdentity = Boolean(name && email);
  status.hasRemote = status.isRepository && remotes.length > 0;
  return finishGitStatus(status);
}

function finishGitStatus(status) {
  // 只读模式下应用不会自动提交笔记，所以即使开了同步也不算「已开启版本记录」。
  status.ready = status.isRepository && status.hasIdentity && status.syncEnabled && !status.readOnly;
  return status;
}

/**
 * 初始化资料库仓库要在终端里跑的命令，只列还缺的那几步。
 *
 * 路径统一转成正斜杠并按 POSIX 规则加单引号：macOS 终端和 Windows Git Bash
 * 都认，路径里有空格、撇号或中文也不会断开。
 */
function gitSetupCommands(vaultDir, status = {}) {
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const lines = ['cd -- ' + quote(String(vaultDir).replaceAll('\\', '/'))];
  if (!status.isRepository) lines.push('git init');
  if (!status.hasIdentity) lines.push('git config user.name "你的名字"', 'git config user.email "你的邮箱"');
  lines.push('git status');
  return lines.join('\n');
}

/**
 * 本机指引状态（导览进度、清单是否隐藏）由桌面壳保存在应用配置目录，不进资料库。
 * 服务端只读它来决定今日页要不要渲染清单；读不到时按默认值处理。
 */
function readGuideState(guide) {
  try { return guide?.read?.() || {}; } catch { return {}; }
}

module.exports = { CORE_STEPS, onboardingProgress, gitSetupStatus, gitSetupCommands, readGuideState };
