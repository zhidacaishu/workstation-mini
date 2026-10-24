#!/usr/bin/env node
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

function unquote(value) {
  const text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function parseLatestYml(content) {
  const lines = String(content || '').replace(/^﻿/, '').split(/\r?\n/);
  let version = '';
  let topPath = '';
  let topSha512 = '';
  let inFiles = false;
  let current = null;
  const entries = [];

  for (const line of lines) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const versionMatch = /^version:\s*(.*?)\s*$/.exec(line);
    if (versionMatch) {
      version = unquote(versionMatch[1]);
      inFiles = false;
      current = null;
      continue;
    }
    if (/^files:\s*$/.test(line)) {
      inFiles = true;
      current = null;
      continue;
    }
    const fileMatch = inFiles ? /^\s+-\s+url:\s*(.*?)\s*$/.exec(line) : null;
    if (fileMatch) {
      current = { url: unquote(fileMatch[1]), sha512: '', size: null };
      entries.push(current);
      continue;
    }
    const metadataMatch = inFiles && current
      ? /^\s+(sha512|size):\s*(.*?)\s*$/.exec(line)
      : null;
    if (metadataMatch) {
      if (metadataMatch[1] === 'sha512') current.sha512 = unquote(metadataMatch[2]);
      else current.size = Number(unquote(metadataMatch[2]));
      continue;
    }
    const pathMatch = /^path:\s*(.*?)\s*$/.exec(line);
    if (pathMatch) {
      topPath = unquote(pathMatch[1]);
      inFiles = false;
      current = null;
      continue;
    }
    const topShaMatch = /^sha512:\s*(.*?)\s*$/.exec(line);
    if (topShaMatch) topSha512 = unquote(topShaMatch[1]);
    if (!/^\s+/.test(line)) {
      inFiles = false;
      current = null;
    }
  }

  if (!version) throw new Error('latest.yml 缺少有效的 version。');
  if (entries.length === 0 && topPath) entries.push({ url: topPath, sha512: topSha512, size: null });
  const files = [...new Set([...entries.map(entry => entry.url), topPath].filter(Boolean))];
  if (files.length === 0) throw new Error('latest.yml 没有引用任何发布文件。');
  for (const file of files) {
    const segments = file.split('/');
    if (
      path.isAbsolute(file)
      || /^[a-zA-Z]:/.test(file)
      || file.startsWith('\\')
      || file.includes('\\')
      || file.includes('\0')
      || segments.some(segment => !segment || segment === '.' || segment === '..')
    ) {
      throw new Error(`latest.yml 包含不安全的文件路径：${file}`);
    }
  }
  for (const entry of entries) {
    if (!entry.sha512) throw new Error(`latest.yml 缺少 ${entry.url} 的 sha512。`);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(`latest.yml 缺少 ${entry.url} 的有效 size。`);
    }
  }
  return { version, files, entries, path: topPath };
}

async function defaultPowerShell(executable) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$target = [System.IO.Path]::GetFullPath('${executable.replace(/'/g, "''")}')`,
    '$signature = Get-AuthenticodeSignature -LiteralPath $target',
    '[pscustomobject]@{ Path = [System.IO.Path]::GetFullPath($signature.Path); Status = [string]$signature.Status; Subject = [string]$signature.SignerCertificate.Subject } | ConvertTo-Json -Compress'
  ].join('; ');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  return stdout;
}

function validateSignatureOutput(output, { executable, publisher }) {
  let result;
  try {
    result = typeof output === 'string' ? JSON.parse(output.trim()) : output;
  } catch {
    throw new Error('签名验证命令返回了无法解析的结果。');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('签名验证结果格式无效。');
  if (result.Status !== 'Valid') throw new Error(`安装包 Authenticode 签名无效：${result.Status || '未知状态'}。`);
  if (path.resolve(String(result.Path || '')).toLowerCase() !== path.resolve(executable).toLowerCase()) {
    throw new Error('签名验证返回的目标路径与安装包不一致。');
  }
  if (String(result.Subject || '') !== publisher) throw new Error('安装包签名者与 WORKSTATION_WINDOWS_PUBLISHER 不一致。');
  return result;
}

function releasePayloadFiles(manifest) {
  const payload = [...manifest.files];
  for (const file of manifest.files) {
    if (file.toLowerCase().endsWith('.exe')) payload.push(`${file}.blockmap`);
  }
  return [...new Set(payload)];
}

async function hashFile(file, algorithm, encoding) {
  const hash = crypto.createHash(algorithm);
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(file);
    input.on('data', chunk => hash.update(chunk));
    input.once('error', reject);
    input.once('end', resolve);
  });
  return hash.digest(encoding);
}

async function verifyManifestEntries(directory, realDirectory, manifest) {
  for (const entry of manifest.entries) {
    const target = await containedFile(directory, realDirectory, entry.url, '发布所需文件');
    const stats = await fsp.stat(target);
    if (stats.size !== entry.size) {
      throw new Error(`latest.yml 中 ${entry.url} 的 size 与实际文件不一致。`);
    }
    const digest = await hashFile(target, 'sha512', 'base64');
    if (digest !== entry.sha512) {
      throw new Error(`latest.yml 中 ${entry.url} 的 sha512 与实际文件不一致。`);
    }
  }
}

async function verifyPackagedPublisher(sourceDir, publisher) {
  const updateConfig = path.join(sourceDir, 'win-unpacked', 'resources', 'app-update.yml');
  let content;
  try {
    content = await fsp.readFile(updateConfig, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('缺少 win-unpacked/resources/app-update.yml，无法验证安装后更新器的 publisherName。');
    throw error;
  }
  const lines = content.replace(/^﻿/, '').split(/\r?\n/);
  const start = lines.findIndex(line => /^publisherName:\s*$/.test(line));
  const values = [];
  if (start !== -1) {
    for (let index = start + 1; index < lines.length; index += 1) {
      const match = /^\s+-\s+(.*?)\s*$/.exec(lines[index]);
      if (!match) break;
      values.push(unquote(match[1]));
    }
  }
  if (!values.includes(publisher)) {
    throw new Error('app-update.yml 的 publisherName 与 WORKSTATION_WINDOWS_PUBLISHER 不一致。');
  }
  return updateConfig;
}

function isContained(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function containedFile(directory, realDirectory, relative, description) {
  const target = path.resolve(directory, ...relative.split('/'));
  if (!isContained(directory, target)) throw new Error(`${description}路径越界：${relative}`);

  let realTarget;
  try {
    realTarget = await fsp.realpath(target);
  } catch {
    throw new Error(`${description}不存在：${relative}`);
  }
  if (!isContained(realDirectory, realTarget)) {
    throw new Error(`${description}通过符号链接越界：${relative}`);
  }
  const stats = await fsp.stat(realTarget);
  if (!stats.isFile()) throw new Error(`${description}不存在：${relative}`);
  return target;
}

async function verifyRelease({
  sourceDir,
  packageVersion,
  publisher,
  runPowerShell = defaultPowerShell,
  verifyUpdaterConfig = false
} = {}) {
  if (!sourceDir) throw new Error('缺少发布产物目录。');
  if (!packageVersion) throw new Error('缺少 package.json 版本。');
  if (!String(publisher || '').trim()) throw new Error('缺少 WORKSTATION_WINDOWS_PUBLISHER。');
  const directory = path.resolve(sourceDir);
  const realDirectory = await fsp.realpath(directory);
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const executables = entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'));
  if (executables.length !== 1) throw new Error(`期望发布目录里正好有一个 .exe，实际有 ${executables.length} 个。`);

  const manifestPath = await containedFile(directory, realDirectory, 'latest.yml', '发布清单');
  const manifest = parseLatestYml(await fsp.readFile(manifestPath, 'utf8'));
  if (manifest.version !== packageVersion) {
    throw new Error(`版本对不上：package.json 是 ${packageVersion}，latest.yml 是 ${manifest.version}。`);
  }
  if (manifest.files.some(file => file.toLowerCase() === 'latest.yml')) {
    throw new Error('latest.yml 不能把自身列为发布文件。');
  }
  const payload = releasePayloadFiles(manifest);
  for (const referenced of payload) {
    await containedFile(directory, realDirectory, referenced, '发布所需文件');
  }
  await verifyManifestEntries(directory, realDirectory, manifest);
  const executableName = executables[0].name;
  const referencedExecutables = manifest.files.filter(file => file.toLowerCase().endsWith('.exe'));
  if (referencedExecutables.length !== 1 || referencedExecutables[0] !== executableName) {
    throw new Error('latest.yml 必须且只能引用已验证的顶层安装包。');
  }

  const executable = await containedFile(
    directory,
    realDirectory,
    executableName,
    '安装包'
  );
  let output;
  try {
    output = await runPowerShell(executable);
  } catch (error) {
    throw new Error(`执行 Authenticode 签名验证失败：${error.message}`);
  }
  const normalizedPublisher = String(publisher).trim();
  validateSignatureOutput(output, { executable, publisher: normalizedPublisher });
  const updaterConfig = verifyUpdaterConfig
    ? await verifyPackagedPublisher(directory, normalizedPublisher)
    : null;
  return { directory, executable, manifestPath, manifest, payload, updaterConfig };
}

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? '' : String(process.argv[index + 1] || '');
}

async function main() {
  const projectDir = path.resolve(__dirname, '..');
  const { version } = require('../package.json');
  const sourceDir = path.resolve(projectDir, argumentValue('--dir') || 'dist');
  const result = await verifyRelease({
    sourceDir,
    packageVersion: version,
    publisher: process.env.WORKSTATION_WINDOWS_PUBLISHER,
    verifyUpdaterConfig: !argumentValue('--dir')
  });
  console.log(`发布签名验证通过：${result.executable}`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exit(1); });

module.exports = {
  parseLatestYml,
  releasePayloadFiles,
  validateSignatureOutput,
  verifyRelease,
  verifyPackagedPublisher,
  hashFile,
  defaultPowerShell
};
