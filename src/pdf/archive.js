const path = require('node:path');
const yauzl = require('yauzl');

const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 10_000;

function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true
    }, (error, zip) => error ? reject(error) : resolve(zip));
  });
}

function safeEntryName(value) {
  const name = String(value || '').replaceAll('\\', '/');
  if (!name || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return '';
  const segments = name.split('/');
  if (segments.some(segment => segment === '..' || segment === '.')) return '';
  return name;
}

function isSymbolicLink(entry) {
  return ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000;
}

function candidate(name) {
  const base = path.posix.basename(name);
  if (base === 'full.md') return { type: 'markdown', priority: 2 };
  if (/\.md$/i.test(base)) return { type: 'markdown', priority: 1 };
  if (base === 'content_list.json') return { type: 'contentList', priority: 2 };
  if (/_content_list\.json$/i.test(base)) return { type: 'contentList', priority: 1 };
  return null;
}

function readEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      const chunks = [];
      let size = 0;
      stream.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_ENTRY_BYTES) stream.destroy(new Error('MinerU 归档条目解压后过大。'));
        else chunks.push(chunk);
      });
      stream.once('error', reject);
      stream.once('end', () => resolve(Buffer.concat(chunks, size)));
    });
  });
}

async function readMineruArchive(filePath) {
  const zip = await openZip(filePath);
  const selected = { markdown: null, contentList: null };
  let entryCount = 0;

  try {
    await new Promise((resolve, reject) => {
      let reading = false;
      const fail = error => {
        if (!reading) zip.close();
        reject(error);
      };
      zip.once('error', fail);
      zip.once('end', resolve);
      zip.on('entry', entry => {
        entryCount += 1;
        if (entryCount > MAX_ENTRIES) {
          fail(new Error('MinerU 归档包含过多条目。'));
          return;
        }
        const name = safeEntryName(entry.fileName);
        if (!name) {
          fail(new Error('MinerU 归档包含不安全路径。'));
          return;
        }
        if (isSymbolicLink(entry)) {
          fail(new Error('MinerU 归档包含符号链接。'));
          return;
        }
        if (/\/$/.test(name)) {
          zip.readEntry();
          return;
        }

        const match = candidate(name);
        if (!match) {
          zip.readEntry();
          return;
        }
        if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
          fail(new Error('MinerU 归档条目解压后过大。'));
          return;
        }
        const current = selected[match.type];
        if (current && current.priority >= match.priority) {
          if (current.priority === match.priority) {
            fail(new Error(`MinerU 归档包含重复的 ${match.type === 'markdown' ? 'Markdown' : 'content_list'}。`));
            return;
          }
          zip.readEntry();
          return;
        }

        reading = true;
        readEntry(zip, entry).then(buffer => {
          reading = false;
          selected[match.type] = { priority: match.priority, name, buffer };
          zip.readEntry();
        }, error => {
          reading = false;
          fail(error);
        });
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }

  if (!selected.markdown || !selected.contentList) {
    throw new Error('MinerU 归档缺少 Markdown 或 content_list.json。');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let markdown;
  let contentListText;
  try {
    markdown = decoder.decode(selected.markdown.buffer);
    contentListText = decoder.decode(selected.contentList.buffer);
  } catch {
    throw new Error('MinerU Markdown 或 content_list.json 不是有效 UTF-8。');
  }
  if (!markdown.trim()) throw new Error('MinerU Markdown 为空。');
  let contentList;
  try {
    contentList = JSON.parse(contentListText);
  } catch {
    throw new Error('MinerU content_list.json 无法解析。');
  }
  return { markdown, contentList, contentListText };
}

module.exports = {
  readMineruArchive,
  safeEntryName,
  candidate,
  MAX_ENTRY_BYTES,
  MAX_ENTRIES
};
