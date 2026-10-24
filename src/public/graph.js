// 力导向图谱，初始圆形布局立即可用，精排交给 Worker，绝不阻塞主线程。
(() => {
  const box = document.getElementById('graph');
  if (!box) return;
  let data;
  try { data = JSON.parse(decodeURIComponent(box.dataset.graph || '{}')); } catch { return; }
  if (!data.nodes?.length) return;

  const W = box.clientWidth || 900, H = 460;
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'graph-svg');
  box.append(svg);

  const nodes = data.nodes.map((node, index) => {
    const angle = (index / data.nodes.length) * Math.PI * 2;
    return {
      ...node,
      x: W / 2 + Math.cos(angle) * W * 0.3,
      y: H / 2 + Math.sin(angle) * H * 0.35,
      vx: 0,
      vy: 0
    };
  });
  const byId = new Map(nodes.map(node => [node.id, node]));
  const edges = data.edges
    .map(edge => ({ s: byId.get(edge.from), t: byId.get(edge.to) }))
    .filter(edge => edge.s && edge.t);
  const lines = edges.map(() => {
    const line = document.createElementNS(svgNs, 'line');
    line.setAttribute('class', 'graph-edge');
    svg.append(line);
    return line;
  });
  const dots = nodes.map(node => {
    const group = document.createElementNS(svgNs, node.path ? 'a' : 'g');
    if (node.path) {
      group.setAttribute('href', `/note/${node.path.split('/').map(encodeURIComponent).join('/')}`);
      group.setAttribute('class', 'graph-node-link');
      group.setAttribute('aria-label', node.label);
    }
    const circle = document.createElementNS(svgNs, 'circle');
    circle.setAttribute('r', String(Math.min(4 + node.degree * 1.4, 12)));
    circle.setAttribute('class', `graph-node${node.status === 'done' ? ' is-done' : ''}${node.degree === 0 ? ' is-orphan' : ''}`);
    const text = document.createElementNS(svgNs, 'text');
    text.setAttribute('class', 'graph-label');
    text.textContent = node.label.length > 14 ? `${node.label.slice(0, 14)}…` : node.label;
    const tooltip = document.createElementNS(svgNs, 'title');
    tooltip.textContent = node.label;
    group.append(circle, text, tooltip);
    svg.append(group);
    return { circle, text };
  });

  function draw() {
    edges.forEach((edge, index) => {
      lines[index].setAttribute('x1', edge.s.x); lines[index].setAttribute('y1', edge.s.y);
      lines[index].setAttribute('x2', edge.t.x); lines[index].setAttribute('y2', edge.t.y);
    });
    nodes.forEach((node, index) => {
      dots[index].circle.setAttribute('cx', node.x); dots[index].circle.setAttribute('cy', node.y);
      dots[index].text.setAttribute('x', node.x); dots[index].text.setAttribute('y', node.y - 12);
    });
  }

  draw();

  let worker;
  try {
    worker = new Worker('/static/graph-worker.js');
    worker.addEventListener('message', event => {
      const result = event.data?.nodes;
      const inputIds = new Set(nodes.map(node => node.id));
      const seen = new Set();
      const valid = Array.isArray(result)
        && result.length === nodes.length
        && result.every(position => position
          && inputIds.has(position.id)
          && !seen.has(position.id)
          && seen.add(position.id)
          && Number.isFinite(position.x)
          && Number.isFinite(position.y));
      if (valid && seen.size === inputIds.size) {
        const positions = new Map(result.map(position => [position.id, position]));
        for (const node of nodes) {
          const position = positions.get(node.id);
          node.x = position.x; node.y = position.y;
        }
        draw();
      }
      worker.terminate();
    }, { once: true });
    worker.addEventListener('error', () => worker.terminate(), { once: true });
    worker.postMessage({ nodes, edges: data.edges, width: W, height: H, steps: 300 });
  } catch {
    // 圆形布局已经画好；Worker 不可用时保持它，不把昂贵算法搬回主线程。
    if (worker) worker.terminate();
  }
})();
