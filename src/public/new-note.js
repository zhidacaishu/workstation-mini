// 新建笔记：先写标题，路径跟着标题生成。
//
// 标题框只是正文的一个入口：真正写进文件的是正文里的标题——普通笔记是第一行的
// `# 标题`，带 frontmatter 的（研究项目）是 `title:` 字段。两边互相同步，所以草稿、
// 保存、恢复都只认正文，不需要另外拼接。路径在用户亲手改过之前一直跟着标题走。
(() => {
  const form = document.querySelector('[data-editor-form]');
  const titleInput = form?.querySelector('[data-note-title]');
  const body = form?.querySelector('[name="body"]');
  const pathInput = form?.querySelector('[name="path"]');
  const autoPath = form?.querySelector('[name="autoPath"]');
  if (!form || !titleInput || !body || !pathInput) return;

  const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
  const TITLE_FIELD = /^title:[ \t]*(.*)$/m;
  const HEADING = /^#[ \t]+(.*)$/;

  function unquote(value) {
    const text = value.trim();
    if (/^".*"$/.test(text)) { try { return JSON.parse(text); } catch { return text.slice(1, -1); } }
    if (/^'.*'$/.test(text)) return text.slice(1, -1).replace(/''/g, "'");
    return text;
  }

  function yamlScalar(value) {
    return value && /[:#[\]{}&*!|>'"%@`,]|^[\s\-?]|\s$/.test(value) ? JSON.stringify(value) : value;
  }

  function readTitle(text) {
    const frontmatter = text.match(FRONTMATTER);
    if (frontmatter) {
      const field = frontmatter[1].match(TITLE_FIELD);
      if (field) return unquote(field[1]);
    }
    const first = text.split('\n')[0];
    const heading = first.match(HEADING);
    return heading ? heading[1].trim() : '';
  }

  function writeTitle(text, title) {
    const frontmatter = text.match(FRONTMATTER);
    if (frontmatter) {
      // 有 frontmatter 时标题只写进 title 字段：插到正文开头的 `# 标题` 会挤在
      // frontmatter 前面，frontmatter 随之失效，标签都没了。
      let block;
      if (TITLE_FIELD.test(frontmatter[1])) {
        block = title
          ? frontmatter[1].replace(TITLE_FIELD, `title: ${yamlScalar(title)}`)
          : frontmatter[1].replace(/^title:[ \t]*.*(?:\r?\n|$)/m, '');
      } else {
        if (!title) return text;
        block = `title: ${yamlScalar(title)}\n${frontmatter[1]}`;
      }
      const start = frontmatter.index + frontmatter[0].indexOf(frontmatter[1]);
      return text.slice(0, start) + block + text.slice(start + frontmatter[1].length);
    }
    const lines = text.split('\n');
    if (HEADING.test(lines[0])) {
      if (title) lines[0] = `# ${title}`;
      else lines.splice(0, lines[1] === '' ? 2 : 1);
      return lines.join('\n');
    }
    return title ? `# ${title}\n\n${text}` : text;
  }

  /** 标题里不能进文件名的字符换成空格；# | [ ] ^ 会和 [[双链]] 语法冲突，也一并去掉。 */
  function fileNameFrom(title) {
    let name = String(title || '').normalize('NFC')
      .replace(/[\u0000-\u001f<>:"/\\|?*#^[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '')
      .replace(/[ .]+$/, '');
    name = [...name].slice(0, 60).join('').replace(/[ .]+$/, '');
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name.split('.')[0])) name += '_';
    return name;
  }

  const folder = pathInput.dataset.folder || 'inbox';
  // 保存请求进行中（路径框只读）不跟：服务端正按提交时的路径写文件，这时改路径，
  // 下一次保存就会当成另一篇新笔记。
  const following = () => pathInput.hasAttribute('data-auto-path') && autoPath?.value === '1' && !pathInput.readOnly;

  function syncPath() {
    if (!following()) return;
    const name = fileNameFrom(titleInput.value);
    pathInput.value = name ? `${folder}/${name}.md` : '';
  }

  // 用户亲手改了路径：从此不再跟着标题变，保存时也不自动避开重名。
  pathInput.addEventListener('input', () => {
    if (autoPath) autoPath.value = '0';
    pathInput.removeAttribute('data-auto-path');
  });

  titleInput.addEventListener('input', () => {
    const next = writeTitle(body.value, titleInput.value.replace(/\s+/g, ' ').trim());
    if (next !== body.value) {
      body.value = next;
      body.dispatchEvent(new Event('input', { bubbles: true }));
    }
    syncPath();
  });

  body.addEventListener('input', event => {
    if (!event.isTrusted) return;
    const title = readTitle(body.value);
    if (title !== titleInput.value.trim()) titleInput.value = title;
    syncPath();
  });

  // 回车从标题跳到正文，接着往下写。
  titleInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    body.focus();
    const lines = body.value.split('\n');
    const frontmatter = body.value.match(FRONTMATTER);
    const offset = frontmatter ? frontmatter[0].length : (HEADING.test(lines[0]) ? lines[0].length + 2 : 0);
    const position = Math.min(offset, body.value.length);
    body.setSelectionRange(position, position);
  });

  titleInput.value = readTitle(body.value);
  syncPath();

  window.workstationNewNote = { readTitle, writeTitle, fileNameFrom };
})();
