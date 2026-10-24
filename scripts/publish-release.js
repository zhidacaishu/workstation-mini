#!/usr/bin/env node
/**
 * 把构建好的安装包发布到大文件存储服务，供各端自动更新。
 *
 *   WORKSTATION_BLOB_URL=https://blobs.example.com \
 *   WORKSTATION_BLOB_RELEASE_TOKEN=xxxx \
 *   WORKSTATION_WINDOWS_PUBLISHER='证书的完整 Subject DN' \
 *   npm run publish-release
 *
 * 也可以 --dir 指向从 CI 产物解压出来的目录；发布前仍会独立验证签名和清单。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const { createBlobClient } = require('../src/blobs/client');
const { normalizeBlobBaseUrl } = require('../src/blobs/url');
const { FEED_PREFIX } = require('../electron/updater');
const { hashFile, parseLatestYml, releasePayloadFiles, verifyRelease } = require('./release-verifier');

const projectDir = path.resolve(__dirname, '..');
const { version: packageVersion } = require('../package.json');

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`缺少环境变量 ${name}。`);
  return value;
}

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? '' : String(process.argv[index + 1] || '');
}

function isContained(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isSameFile(before, current) {
  return before.ino === current.ino
    && (!before.dev || !current.dev || before.dev === current.dev);
}

async function snapshotFile(sourceRoot, realSourceRoot, snapshotRoot, relative) {
  const source = path.join(sourceRoot, ...relative.split('/'));
  const realSource = await fsp.realpath(source);
  if (!isContained(realSourceRoot, realSource)) {
    throw new Error(`发布文件通过符号链接越界：${relative}`);
  }

  const target = path.join(snapshotRoot, ...relative.split('/'));
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const handle = await fsp.open(realSource, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`发布文件不是普通文件：${relative}`);
    const currentRealSource = await fsp.realpath(source);
    if (!isContained(realSourceRoot, currentRealSource)) {
      throw new Error(`发布文件通过符号链接越界：${relative}`);
    }
    const current = await fsp.stat(source);
    if (!isSameFile(before, current)) {
      throw new Error(`发布文件在建立快照时发生变化：${relative}`);
    }
    await pipeline(
      fs.createReadStream(null, { fd: handle.fd, autoClose: false }),
      fs.createWriteStream(target, { flags: 'wx' })
    );
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`发布文件在建立快照时发生变化：${relative}`);
    }
  } finally {
    await handle.close();
  }
}

async function createReleaseSnapshot(sourceDir) {
  const sourceRoot = path.resolve(sourceDir);
  const realSourceRoot = await fsp.realpath(sourceRoot);
  const uploadRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'workstation-release-'));
  const snapshotRoot = path.join(uploadRoot, FEED_PREFIX);
  try {
    await fsp.mkdir(snapshotRoot, { recursive: true });
    await snapshotFile(sourceRoot, realSourceRoot, snapshotRoot, 'latest.yml');
    const manifest = parseLatestYml(await fsp.readFile(path.join(snapshotRoot, 'latest.yml'), 'utf8'));
    for (const relative of releasePayloadFiles(manifest)) {
      await snapshotFile(sourceRoot, realSourceRoot, snapshotRoot, relative);
    }
    return { uploadRoot, directory: snapshotRoot };
  } catch (error) {
    await fsp.rm(uploadRoot, { recursive: true, force: true });
    throw error;
  }
}

async function payloadIntegrity(directory, payload) {
  const entries = new Map();
  for (const relative of payload) {
    const target = path.join(directory, ...relative.split('/'));
    const stats = await fsp.stat(target);
    entries.set(relative, {
      size: stats.size,
      sha256: await hashFile(target, 'sha256', 'hex')
    });
  }
  return entries;
}

async function publishRelease({
  sourceDir,
  packageVersion,
  publisher,
  baseUrl,
  releaseToken,
  verify = verifyRelease,
  createClient = createBlobClient,
  logger = console
}) {
  const normalizedBaseUrl = normalizeBlobBaseUrl(baseUrl);
  if (!String(releaseToken || '').trim()) throw new Error('缺少发布令牌。');

  const snapshot = await createReleaseSnapshot(sourceDir);

  try {
    const verified = await verify({
      sourceDir: snapshot.directory,
      packageVersion,
      publisher
    });
    const payload = [...verified.payload];
    const expected = await payloadIntegrity(snapshot.directory, payload);
    const blobs = createClient({ baseUrl: normalizedBaseUrl, token: releaseToken });
    logger.log(`发布 ${packageVersion} 到 ${normalizedBaseUrl}/blobs/${FEED_PREFIX}\n`);
    logger.log(`[1/3] 上传清单引用的文件（${payload.length} 个）…`);

    for (const relative of payload) {
      const result = await blobs.upload(`${FEED_PREFIX}/${relative}`, snapshot.uploadRoot);
      if (!result.ok) throw new Error(`${relative} 上传失败：${result.reason || '未知错误'}。发布中止。`);
      logger.log(`  ${relative}（${(result.size / 1024 / 1024).toFixed(1)} MB）`);
    }

    logger.log('\n[2/3] 核对服务器上的清单文件…');
    const remote = await blobs.list({ prefix: FEED_PREFIX, integrity: 'sha256' });
    if (!remote.ok) throw new Error(`列出发布文件失败：${remote.reason || '未知错误'}。发布中止。`);
    const remoteByPath = new Map(remote.blobs.map(blob => [blob.path, blob]));
    const mismatches = [];
    for (const relative of payload) {
      const actual = remoteByPath.get(`${FEED_PREFIX}/${relative}`);
      const wanted = expected.get(relative);
      if (!actual) mismatches.push(`${relative}（缺失）`);
      else if (actual.size !== wanted.size) mismatches.push(`${relative}（大小不一致）`);
      else if (!actual.sha256) mismatches.push(`${relative}（服务端未提供 SHA-256）`);
      else if (actual.sha256 !== wanted.sha256) mismatches.push(`${relative}（SHA-256 不一致）`);
    }
    if (mismatches.length > 0) {
      throw new Error(`服务器上的发布文件未通过完整性核对：${mismatches.join('、')}。发布中止。`);
    }

    logger.log('\n[3/3] 上传 latest.yml，正式放出这个版本…');
    const manifest = await blobs.upload(`${FEED_PREFIX}/latest.yml`, snapshot.uploadRoot);
    if (!manifest.ok) {
      throw new Error(`latest.yml 上传失败：${manifest.reason || '未知错误'}。安装包已经就位，修复后重跑即可。`);
    }

    logger.log(`\n已发布 ${packageVersion}。各端会在下次检查更新时取到它。`);
    return { ok: true, payload, manifest: 'latest.yml' };
  } finally {
    await fsp.rm(snapshot.uploadRoot, { recursive: true, force: true });
  }
}

async function main() {
  await publishRelease({
    sourceDir: path.resolve(projectDir, argumentValue('--dir') || 'dist'),
    packageVersion,
    publisher: required('WORKSTATION_WINDOWS_PUBLISHER'),
    baseUrl: required('WORKSTATION_BLOB_URL'),
    releaseToken: required('WORKSTATION_BLOB_RELEASE_TOKEN')
  });
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { publishRelease, createReleaseSnapshot, payloadIntegrity, main, required, argumentValue };
