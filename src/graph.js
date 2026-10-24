const fs = require('node:fs');
const path = require('node:path');

// 两种边类型共用一个渲染器：
//   link   —— 笔记之间的双链，弱方向性
//   prereq —— 知识点的前置依赖，有向无环
const EDGE_LINK = 'link';
const EDGE_PREREQ = 'prereq';

/**
 * 依赖边人工维护在 vault 的 graph/prereq.yaml 里。
 *
 * 沿用 myblog 里 article-edges.ts 的做法：边是人写的，不靠程序猜。
 * 猜出来的依赖关系不可信，而这张图的用处恰恰在于「哪些前置我还没打通」——
 * 猜错一条就会给出错误的学习顺序。
 *
 * 格式刻意做得极简，不引 YAML 解析器：
 *   计量/ch04: [计量/ch03, 概率论/ch07]
 */
function parsePrereqFile(text) {
  const edges = [];
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const match = line.match(/^(.+?)\s*:\s*\[(.*)\]$/) || line.match(/^(.+?)\s*:\s*(.*)$/);
    if (!match) continue;

    const to = match[1].trim();
    if (!to) continue;
    for (const from of match[2].split(',').map(part => part.trim().replace(/^["']|["']$/g, '')).filter(Boolean)) {
      // 边的方向是「先修 → 后修」：从前置指向依赖它的那个。
      edges.push({ from, to, type: EDGE_PREREQ });
    }
  }
  return edges;
}

function readPrereqEdges(vaultDir) {
  const file = path.join(vaultDir, 'graph', 'prereq.yaml');
  try {
    return parsePrereqFile(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * 依赖图里找出「还没打通的前置」。
 *
 * 一个章节即使自己标成 todo，只要它的前置里还有没打通的，就不该现在学 ——
 * 地基没打牢往上堆，是自学最常见的失败方式。
 */
function blockedNodes(edges, statusOf) {
  const incoming = new Map();
  for (const edge of edges) {
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    incoming.get(edge.to).push(edge.from);
  }

  const blocked = [];
  for (const [node, prerequisites] of incoming) {
    const unmet = prerequisites.filter(from => statusOf(from) !== 'done');
    if (unmet.length) blocked.push({ node, unmet });
  }
  return blocked.sort((a, b) => b.unmet.length - a.unmet.length || a.node.localeCompare(b.node));
}

/**
 * 组装图数据。双链图和依赖图共用同一套结构，只是边类型不同。
 *
 * 孤岛（没有任何连接的笔记）单独标出来 —— 它们是知识库体检的重点：
 * 记了但从没被引用过的笔记，多半也从没被再看过。
 */
function buildGraph(db, { type = EDGE_LINK, vaultDir = '', limit = 400 } = {}) {
  if (type === EDGE_PREREQ) {
    const edges = readPrereqEdges(vaultDir);
    const names = new Set(edges.flatMap(edge => [edge.from, edge.to]));

    // 依赖图的节点名对应 reading/ 下的笔记，能对上就带出状态和链接。
    const byName = new Map();
    for (const row of db.listItems('reading')) {
      let data = {};
      try { data = JSON.parse(row.dataJson || '{}') || {}; } catch { data = {}; }
      const key = row.path.replace(/^reading\//, '').replace(/\.md$/, '');
      byName.set(key, { path: row.path, title: row.title, status: data.status || 'todo' });
    }

    const nodes = [...names].map(name => ({
      id: name,
      label: byName.get(name)?.title || name,
      path: byName.get(name)?.path || '',
      status: byName.get(name)?.status || '',
      degree: edges.filter(edge => edge.from === name || edge.to === name).length
    }));

    return {
      type,
      nodes,
      edges,
      orphans: [],
      blocked: blockedNodes(edges, name => byName.get(name)?.status)
    };
  }

  const rows = db.raw.prepare(`
    SELECT path, title_raw AS title, section FROM notes ORDER BY path LIMIT ?
  `).all(limit);
  const known = new Set(rows.map(row => row.path));

  const edges = db.raw.prepare(`
    SELECT from_path AS "from", to_path AS "to" FROM links WHERE to_path != ''
  `).all()
    .filter(edge => known.has(edge.from) && known.has(edge.to))
    .map(edge => ({ ...edge, type: EDGE_LINK }));

  const degree = new Map();
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
  }

  const nodes = rows.map(row => ({
    id: row.path,
    label: row.title,
    path: row.path,
    section: row.section,
    degree: degree.get(row.path) || 0
  }));

  return {
    type,
    nodes,
    edges,
    orphans: nodes.filter(node => node.degree === 0),
    blocked: []
  };
}

module.exports = { EDGE_LINK, EDGE_PREREQ, parsePrereqFile, readPrereqEdges, blockedNodes, buildGraph };
