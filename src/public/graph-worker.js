// 图布局放进 Worker，避免 300 步 O(n²) 斥力计算阻塞页面交互。
self.addEventListener('message', event => {
  const { nodes = [], edges = [], width: W, height: H, steps = 300 } = event.data || {};
  const byId = new Map(nodes.map(node => [node.id, node]));
  const linked = edges
    .map(edge => ({ s: byId.get(edge.from), t: byId.get(edge.to) }))
    .filter(edge => edge.s && edge.t);
  const repulsion = 5200;

  for (let step = 0; step < steps; step += 1) {
    const cooling = 1 - step / steps;
    for (const node of nodes) { node.vx = 0; node.vy = 0; }

    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        const distanceSquared = Math.max(dx * dx + dy * dy, 25);
        const force = repulsion / distanceSquared;
        dx *= force; dy *= force;
        a.vx -= dx; a.vy -= dy; b.vx += dx; b.vy += dy;
      }
    }
    for (const edge of linked) {
      const dx = (edge.t.x - edge.s.x) * 0.05;
      const dy = (edge.t.y - edge.s.y) * 0.05;
      edge.s.vx += dx; edge.s.vy += dy;
      edge.t.vx -= dx; edge.t.vy -= dy;
    }
    for (const node of nodes) {
      node.vx += (W / 2 - node.x) * 0.02;
      node.vy += (H / 2 - node.y) * 0.02;
      node.x = Math.max(34, Math.min(W - 34, node.x + node.vx * cooling));
      node.y = Math.max(28, Math.min(H - 28, node.y + node.vy * cooling));
    }
  }

  self.postMessage({ nodes: nodes.map(({ id, x, y }) => ({ id, x, y })) });
});
