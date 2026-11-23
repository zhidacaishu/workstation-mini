const fsp = require('node:fs/promises');
const path = require('node:path');

/**
 * 在设置里换资料库之前的检查。
 *
 * 资料库路径是一个能手打的文本框。以前只检查是不是绝对路径：打错一个字，
 * 启动时 mkdir -p 就悄悄建出一个空资料库并切过去，看起来像笔记全丢了。
 *
 * - 路径没变：不检查（只改别的设置时不该因为资料库暂时不在而存不了）。
 * - 必须是已经存在的目录。
 * - 用「选择」按钮挑的目录（可以在对话框里新建）可以是空目录，那是在建新资料库；
 *   手打的路径必须看得出是资料库：里面已经有 notes/、cards/、reviews/ 或 .git。
 *   这里只防打错字，不用恢复流程那套严格校验：资料库本身是指向云盘的符号链接、
 *   .git 是文件（worktree、子模块）都是正常用法。
 */
const VAULT_MARKERS = ['notes', 'cards', 'reviews', '.git'];

async function checkVaultChange({
  previousVaultDir = '',
  nextVaultDir = '',
  pickedDirs = new Set(),
  stat = target => fsp.stat(target)
}) {
  const next = String(nextVaultDir).trim();
  if (sameDir(next, previousVaultDir)) return;
  let info;
  try {
    info = await stat(next);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new Error(`资料库目录不存在：${next}。请检查路径，或者用「选择」按钮挑选、新建目录。`);
    }
    throw error;
  }
  if (!info.isDirectory()) throw new Error(`资料库路径不是目录：${next}`);
  if ([...pickedDirs].some(picked => sameDir(picked, next))) return;
  for (const marker of VAULT_MARKERS) {
    try {
      const entry = await stat(path.join(next, marker));
      // .git 在 worktree、子模块里是文件；其余必须是目录。
      if (marker === '.git' || entry.isDirectory()) return;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
  }
  throw new Error(`这个目录里没有 notes、cards、reviews 或 .git，不像资料库：${next}。新建资料库请用「选择」按钮挑选或新建目录。`);
}

function sameDir(left, right) {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  if (!a || !b) return a === b;
  return path.resolve(a) === path.resolve(b);
}

module.exports = { checkVaultChange };
