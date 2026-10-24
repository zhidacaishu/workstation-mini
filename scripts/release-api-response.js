#!/usr/bin/env node

const NOT_FOUND_EXIT_CODE = 4;

function parseIncludedResponse(output) {
  const source = String(output || '');
  const matches = [...source.matchAll(/^HTTP\/\S+\s+(\d{3})(?:\s|$).*$/gm)];
  if (!matches.length) throw new Error('GitHub API response did not include an HTTP status.');
  const match = matches.at(-1);
  const headerEnd = source.slice(match.index).search(/\r?\n\r?\n/);
  if (headerEnd === -1) throw new Error('GitHub API response did not include a complete header block.');
  const absoluteHeaderEnd = match.index + headerEnd;
  const separator = source.slice(absoluteHeaderEnd).match(/^\r?\n\r?\n/)[0];
  return {
    status: Number(match[1]),
    body: source.slice(absoluteHeaderEnd + separator.length)
  };
}

function classifyIncludedResponse(output, exitStatus) {
  const response = parseIncludedResponse(output);
  if (response.status === 404 && exitStatus !== 0) return { kind: 'not-found' };
  if (response.status !== 200 || exitStatus !== 0) {
    throw new Error(`GitHub API lookup failed with HTTP ${response.status} and exit status ${exitStatus}.`);
  }
  let release;
  try {
    release = JSON.parse(response.body);
  } catch {
    throw new Error('GitHub API returned an invalid release response.');
  }
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    throw new Error('GitHub API returned an invalid release response.');
  }
  return { kind: 'found', release };
}

async function main(env = process.env) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const exitStatus = Number(env.GH_API_EXIT_STATUS);
  if (!Number.isInteger(exitStatus) || exitStatus < 0) {
    throw new Error('GH_API_EXIT_STATUS must be a non-negative integer.');
  }
  const result = classifyIncludedResponse(Buffer.concat(chunks).toString('utf8'), exitStatus);
  if (result.kind === 'not-found') {
    process.exitCode = NOT_FOUND_EXIT_CODE;
    return result;
  }
  process.stdout.write(`${JSON.stringify(result.release)}\n`);
  return result;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { NOT_FOUND_EXIT_CODE, parseIncludedResponse, classifyIncludedResponse, main };
