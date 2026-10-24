const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// vault 内部一律用正斜杠表示相对路径。
//
// 这不是风格问题：同一个 vault 会在 Windows 和 macOS 之间用 git 同步。如果在
// Windows 上把 `diary\2026-08-06.md` 写进索引和双链，换到 macOS 就全部对不上。
// 所以「vault 相对路径」这个概念在整个程序里只有一种写法——正斜杠。
// 只有真正要碰文件系统时才转成平台原生分隔符。

function toPosix(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/\/+/g, '/');
}

function samePath(left, right) {
  const normalize = value => process.platform === 'win32'
    ? path.resolve(value).toLowerCase()
    : path.resolve(value);
  return normalize(left) === normalize(right);
}

function assertInsideRoot(root, target) {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('目标路径超出资料库目录。');
  }
  return relative;
}

async function ensureSafeTargetParent(targetDir, absolute, { create = false } = {}) {
  const root = path.resolve(targetDir);
  const relative = assertInsideRoot(root, path.dirname(absolute));
  const rootReal = await fsp.realpath(root);
  if (!(await fsp.stat(rootReal)).isDirectory()) throw new Error('资料库不是目录。');
  let current = root;
  let expectedReal = rootReal;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    expectedReal = path.join(expectedReal, segment);
    if (create) {
      try {
        await fsp.mkdir(current);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    const stats = await fsp.lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('目标路径包含符号链接或非目录祖先。');
    }
    if (!samePath(await fsp.realpath(current), expectedReal)) {
      throw new Error('目标路径离开了资料库目录。');
    }
  }
  return absolute;
}

function ensureSafeTargetParentSync(targetDir, absolute) {
  const root = path.resolve(targetDir);
  const relative = assertInsideRoot(root, path.dirname(absolute));
  const rootReal = fs.realpathSync(root);
  if (!fs.statSync(rootReal).isDirectory()) throw new Error('资料库不是目录。');
  let current = root;
  let expectedReal = rootReal;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    expectedReal = path.join(expectedReal, segment);
    const stats = fs.lstatSync(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('目标路径包含符号链接或非目录祖先。');
    }
    if (!samePath(fs.realpathSync(current), expectedReal)) {
      throw new Error('目标路径离开了资料库目录。');
    }
  }
  return absolute;
}

async function ensureSafeFilePath(vaultDir, relativePath, { allowMissing = false, createParents = false } = {}) {
  const absolute = toAbsolute(vaultDir, relativePath);
  await ensureSafeTargetParent(vaultDir, absolute, { create: createParents });
  try {
    const stats = await fsp.lstat(absolute);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('目标不是普通文件。');
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return absolute;
    throw error;
  }
  return absolute;
}

function ensureSafeFilePathSync(vaultDir, relativePath) {
  const absolute = toAbsolute(vaultDir, relativePath);
  ensureSafeTargetParentSync(vaultDir, absolute);
  const stats = fs.lstatSync(absolute);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('目标不是普通文件。');
  return absolute;
}

/**
 * 把 vault 内的绝对路径转成正斜杠相对路径。不在 vault 内则返回空串。
 */
function toRelative(vaultDir, absolutePath) {
  const relative = path.relative(vaultDir, absolutePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
  return toPosix(relative);
}

/**
 * 判断一个相对路径是否安全：不越界、不是绝对路径、不含盘符。
 *
 * HTTP 请求会直接把路径传进来，所以这里是防目录穿越的关口。
 * `path.resolve` 之后再比较前缀，能挡住 `../`、`..\\`、`%2e%2e` 解码后的形式，
 * 以及 Windows 上的 `C:\` 和 `\\server\share` 这类写法。
 */
function isSafeRelativePath(relativePath) {
  const value = String(relativePath ?? '');
  if (!value) return false;
  // Windows 盘符与 UNC 路径：path.isAbsolute 在 Linux 上不认这两种。
  if (/^[a-zA-Z]:/.test(value)) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (path.isAbsolute(value)) return false;

  // 按分隔符切开时不折叠重复分隔符：`a//b` 和 `a/b` 指向同一个文件，
  // 但会在索引里变成两行、在双链里变成两个目标。非规范写法直接拒绝。
  const segments = value.split(/[\\/]/);
  return !segments.some(segment => {
    if (segment === '..' || segment === '.' || segment === '') return true;
    if (/[<>:"|?*]/.test(segment) || /[ .]$/.test(segment)) return true;
    if ([...segment].some(character => character.charCodeAt(0) < 32)) return true;
    const stem = segment.split('.')[0].replace(/[ .]+$/g, '');
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem);
  });
}

/**
 * 相对路径转 vault 内的绝对路径。路径不安全时抛错，绝不返回 vault 之外的位置。
 */
function toAbsolute(vaultDir, relativePath) {
  if (!isSafeRelativePath(relativePath)) {
    throw new Error(`Unsafe vault path: ${relativePath}`);
  }
  const absolute = path.resolve(vaultDir, ...toPosix(relativePath).split('/'));

  // resolve 之后再确认一次。符号链接不在这里处理——indexer 扫描时不跟随符号链接。
  const relative = path.relative(vaultDir, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Vault path escapes the vault: ${relativePath}`);
  }
  return absolute;
}

/**
 * 笔记所属的分区：`diary/2026-08-06.md` → `diary`。顶层文件返回空串。
 */
function sectionOf(relativePath) {
  const segments = toPosix(relativePath).split('/');
  return segments.length > 1 ? segments[0] : '';
}

/**
 * 去掉扩展名的路径，也是 wikilink 的规范目标形式。
 * `notes/diary/2026-08-06.md` → `notes/diary/2026-08-06`
 */
function stripExtension(relativePath) {
  return toPosix(relativePath).replace(/\.[^./]+$/, '');
}

function basename(relativePath) {
  return stripExtension(toPosix(relativePath).split('/').pop() || '');
}

function encodePath(relativePath) {
  return toPosix(relativePath).split('/').map(encodeURIComponent).join('/');
}

module.exports = {
  toPosix,
  toRelative,
  toAbsolute,
  isSafeRelativePath,
  ensureSafeTargetParent,
  ensureSafeTargetParentSync,
  ensureSafeFilePath,
  ensureSafeFilePathSync,
  sectionOf,
  stripExtension,
  basename,
  encodePath
};
