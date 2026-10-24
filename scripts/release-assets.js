#!/usr/bin/env node
const fsp = require('node:fs/promises');
const path = require('node:path');

function parsePages(input) {
  let parsed;
  try {
    parsed = JSON.parse(String(input || ''));
  } catch {
    throw new Error('GitHub returned invalid release asset JSON.');
  }
  if (!Array.isArray(parsed) || parsed.some(page => !Array.isArray(page))) {
    throw new Error('GitHub returned an invalid release asset page set.');
  }
  return parsed.flat().map(asset => {
    if (!Number.isSafeInteger(asset?.id) || asset.id <= 0
      || typeof asset.name !== 'string' || !asset.name
      || path.basename(asset.name) !== asset.name
      || !Number.isSafeInteger(asset.size) || asset.size < 0) {
      throw new Error('GitHub returned invalid release asset metadata.');
    }
    return { id: asset.id, name: asset.name, size: asset.size };
  });
}

function assertUnique(assets, label) {
  const names = new Set();
  for (const asset of assets) {
    if (names.has(asset.name)) throw new Error(`${label} contains a duplicate asset name: ${asset.name}`);
    names.add(asset.name);
  }
}

async function expectedAssets(files) {
  const assets = await Promise.all(files.map(async file => {
    if (/[\r\n]/.test(file)) throw new Error('Release asset path contains a newline.');
    const stats = await fsp.stat(file);
    if (!stats.isFile()) throw new Error(`Release asset is not a file: ${file}`);
    return { name: path.basename(file), size: stats.size };
  }));
  assertUnique(assets, 'Local release set');
  return assets.sort((left, right) => left.name.localeCompare(right.name));
}

async function planAssets(remote, files) {
  assertUnique(remote, 'GitHub release');
  const expected = await expectedAssets(files);
  const expectedByName = new Map(expected.map(asset => [asset.name, asset]));
  const fileByName = new Map(files.map(file => [path.basename(file), file]));
  const existing = [];
  for (const asset of remote) {
    const local = expectedByName.get(asset.name);
    if (!local || local.size !== asset.size) {
      throw new Error('GitHub draft contains an unexpected or mismatched asset.');
    }
    existing.push({ id: asset.id, file: fileByName.get(asset.name) });
  }
  const present = new Set(remote.map(asset => asset.name));
  const missing = files.filter(file => !present.has(path.basename(file)));
  return { existing, missing };
}

async function planMissingAssets(remote, files) {
  return (await planAssets(remote, files)).missing;
}

async function verifyAssets(remote, files) {
  const missing = await planMissingAssets(remote, files);
  if (missing.length || remote.length !== files.length) {
    throw new Error('GitHub draft assets do not exactly match the verified local file set.');
  }
  return remote
    .map(({ name, size }) => ({ name, size }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function main(argv = process.argv.slice(2)) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const assets = parsePages(Buffer.concat(chunks).toString('utf8'));
  if (argv[0] === '--plan' && argv.length > 1) {
    const plan = await planAssets(assets, argv.slice(1));
    for (const asset of plan.existing) process.stdout.write(`existing\t${asset.id}\t${asset.file}\n`);
    for (const file of plan.missing) process.stdout.write(`missing\t${file}\n`);
    return plan;
  }
  if (argv[0] === '--verify' && argv.length > 1) {
    return verifyAssets(assets, argv.slice(1));
  }
  throw new Error('Usage: release-assets.js --plan <files...> | --verify <files...>');
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parsePages, expectedAssets, planAssets, planMissingAssets, verifyAssets, main };
