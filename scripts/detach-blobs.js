#!/usr/bin/env node
/**
 * 把已经进了 Git 的二进制资源迁到大文件存储服务。
 *
 * 只加 .gitignore 是不够的：Git 只对未跟踪的文件生效，已经提交过的
 * audio/ 和 attachments/ 会继续跟着每次提交走。真正要做的是先把它们
 * 传到存储服务，确认服务器上确实有了，再从 Git 索引里摘掉。
 *
 * 顺序不能反 —— 先摘再传的话，中间任何一步失败都可能让素材两头都没有。
 *
 * 用法：
 *   WORKSTATION_VAULT=~/workstation-vault \
 *   WORKSTATION_BLOB_URL=https://blobs.example.com \
 *   WORKSTATION_BLOB_TOKEN=xxxx \
 *   node scripts/detach-blobs.js [--detach]
 *
 * 不带 --detach 时只上传和核对，并把该执行的 git 命令打印出来给你自己跑。
 */
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createBlobClient } = require('../src/blobs/client');
const { normalizeBlobBaseUrl } = require('../src/blobs/url');
const { reconcileBlobs, listLocal, MANAGED_PREFIXES } = require('../src/blobs/reconcile');

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    console.error(`缺少环境变量 ${name}。`);
    process.exit(1);
  }
  return value;
}

function git(vaultDir, args) {
  return execFileSync('git', ['-C', vaultDir, ...args], { encoding: 'utf8' });
}

async function main() {
  const vaultDir = path.resolve(required('WORKSTATION_VAULT'));
  const detach = process.argv.includes('--detach');

  const blobs = createBlobClient({
    baseUrl: normalizeBlobBaseUrl(required('WORKSTATION_BLOB_URL')),
    token: required('WORKSTATION_BLOB_TOKEN')
  });

  const tracked = MANAGED_PREFIXES.filter(prefix => {
    try {
      return git(vaultDir, ['ls-files', '--error-unmatch', prefix]).trim().length > 0;
    } catch {
      return false;
    }
  });

  console.log(`资料库：${vaultDir}`);
  console.log(`仍被 Git 跟踪的目录：${tracked.length ? tracked.join('、') : '（无）'}`);

  console.log('\n[1/3] 上传并对账…');
  const summary = await reconcileBlobs({ vaultDir, blobs });
  if (!summary.ok) {
    console.error('对账没有全部成功，先解决下面的问题再继续：');
    for (const item of summary.failed) console.error(`  - ${item.path || item.prefix}：${item.reason}`);
    process.exit(1);
  }
  console.log(`  上传 ${summary.uploaded} 个，取回 ${summary.downloaded} 个`);
  if (summary.deferred?.length > 0) {
    console.error('以下文件最近一分钟内还在写入，这一轮没有上传；等它们写完后重新运行本脚本：');
    for (const item of summary.deferred) console.error(`  - ${item}`);
    process.exit(1);
  }
  if (summary.mismatched.length > 0) {
    console.error('以下文件两边大小不一致，请先自己确认保留哪一份：');
    for (const item of summary.mismatched) {
      console.error(`  - ${item.path}（本地 ${item.local} / 服务器 ${item.remote}）`);
    }
    process.exit(1);
  }

  console.log('\n[2/3] 逐个核对服务器上确实有…');
  let missing = 0;
  for (const prefix of MANAGED_PREFIXES) {
    const local = await listLocal(vaultDir, prefix);
    const remote = await blobs.list({ prefix });
    if (!remote.ok) {
      console.error(`  列出 ${prefix} 失败：${remote.reason}`);
      process.exit(1);
    }
    const remotePaths = new Set(remote.blobs.map(blob => blob.path));
    for (const relative of local.keys()) {
      if (!remotePaths.has(relative)) {
        console.error(`  服务器上缺少 ${relative}`);
        missing += 1;
      }
    }
    console.log(`  ${prefix}：本地 ${local.size} 个，服务器 ${remotePaths.size} 个`);
  }
  if (missing > 0) {
    console.error(`\n有 ${missing} 个文件没能上传，不能继续摘除 Git 跟踪。`);
    process.exit(1);
  }

  const commands = tracked.map(prefix => `git -C "${vaultDir}" rm -r --cached ${prefix}`);
  if (tracked.length === 0) {
    console.log('\n[3/3] 这些目录本来就没被 Git 跟踪，无需处理。');
    return;
  }

  if (!detach) {
    console.log('\n[3/3] 核对通过。要真正从 Git 里摘掉，执行：\n');
    for (const command of commands) console.log(`  ${command}`);
    console.log(`  git -C "${vaultDir}" commit -m "chore: 二进制资源改由存储服务托管"\n`);
    console.log('确认无误后也可以直接跑：node scripts/detach-blobs.js --detach');
    return;
  }

  console.log('\n[3/3] 从 Git 索引中摘除（本地文件保留）…');
  for (const prefix of tracked) {
    git(vaultDir, ['rm', '-r', '--cached', '--quiet', prefix]);
    console.log(`  已摘除 ${prefix}`);
  }
  git(vaultDir, ['commit', '-m', 'chore: 二进制资源改由存储服务托管']);
  console.log('\n已提交。下次推送后，远端仓库将不再包含这些目录的新版本。');
  console.log('注意：历史提交里的旧副本仍在，要真正缩小仓库需要单独做历史重写。');
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
