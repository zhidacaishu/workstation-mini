#!/usr/bin/env node
const fsp = require('node:fs/promises');
const path = require('node:path');

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function validateVersionInput(value) {
  const version = String(value || '');
  if (!SEMVER.test(version)) {
    throw new Error('发布版本必须是无 v 前缀、无空白的完整 SemVer，例如 0.2.0。');
  }
  return version;
}

function extractChangelogSection(changelog, version) {
  const heading = `## ${version}`;
  const lines = String(changelog || '').replace(/^﻿/, '').split(/\r?\n/);
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trimEnd() === heading) matches.push(index);
  }
  if (matches.length !== 1) {
    throw new Error(`CHANGELOG.md 必须恰好有一个精确的 ${heading} 章节，实际有 ${matches.length} 个。`);
  }
  const start = matches[0];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join('\n').trim();
  if (!body) throw new Error(`CHANGELOG.md 的 ${heading} 章节不能为空。`);
  return `${heading}\n\n${body}\n`;
}

function validateReleaseMetadata({ version, packageJson, packageLock, changelog }) {
  const normalized = validateVersionInput(version);
  const versions = [
    ['package.json', packageJson?.version],
    ['package-lock.json', packageLock?.version],
    ["package-lock.json packages['']", packageLock?.packages?.['']?.version]
  ];
  for (const [source, actual] of versions) {
    if (actual !== normalized) {
      throw new Error(`${source} 的版本是 ${actual || '缺失'}，与发布版本 ${normalized} 不一致。`);
    }
  }
  const notes = extractChangelogSection(changelog, normalized);
  return { version: normalized, tag: `v${normalized}`, notes };
}

function argumentValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? '' : String(argv[index + 1] || '');
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const projectDir = path.resolve(__dirname, '..');
  const version = argumentValue(argv, '--version');
  const [packageJson, packageLock, changelog] = await Promise.all([
    fsp.readFile(path.join(projectDir, 'package.json'), 'utf8').then(JSON.parse),
    fsp.readFile(path.join(projectDir, 'package-lock.json'), 'utf8').then(JSON.parse),
    fsp.readFile(path.join(projectDir, 'CHANGELOG.md'), 'utf8')
  ]);
  const result = validateReleaseMetadata({ version, packageJson, packageLock, changelog });
  const notesFile = argumentValue(argv, '--notes-file');
  if (notesFile) await fsp.writeFile(path.resolve(notesFile), result.notes, 'utf8');
  if (env.GITHUB_OUTPUT) {
    await fsp.appendFile(env.GITHUB_OUTPUT, `version=${result.version}\ntag=${result.tag}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify({ version: result.version, tag: result.tag })}\n`);
  return result;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`发布预检失败：${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  validateVersionInput,
  extractChangelogSection,
  validateReleaseMetadata,
  argumentValue,
  main
};
