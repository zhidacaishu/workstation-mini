const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'src/public/motion.js'), 'utf8');

function loadMotion({ reduced = false } = {}) {
  const listeners = new Set();
  const query = {
    matches: reduced,
    addEventListener(type, fn) { if (type === 'change') listeners.add(fn); }
  };
  const window = {
    matchMedia: text => (text.includes('prefers-reduced-motion') ? query : { matches: false })
  };
  vm.runInNewContext(script, {
    window,
    document: {},
    WeakMap,
    Map,
    Set,
    Math
  });
  return {
    motion: window.workstationMotion,
    setReduced(next) {
      query.matches = next;
      for (const fn of listeners) fn({ matches: next });
    }
  };
}

function fakeElement(rect = { left: 0, top: 0, width: 100, height: 40 }) {
  let layoutRect = rect;
  let visualOffset = { x: 0, y: 0 };
  const animations = [];
  return {
    isConnected: true,
    animations,
    setRect(next) { layoutRect = next; },
    setVisualOffset(x, y = 0) { visualOffset = { x, y }; },
    getBoundingClientRect() {
      return {
        left: layoutRect.left + visualOffset.x,
        top: layoutRect.top + visualOffset.y,
        width: layoutRect.width,
        height: layoutRect.height
      };
    },
    animate(keyframes, options) {
      const record = {
        keyframes,
        options,
        cancelled: false,
        finished: false,
        listeners: {},
        cancel() {
          this.cancelled = true;
          visualOffset = { x: 0, y: 0 };
          this.listeners.cancel?.();
        },
        finish() {
          this.finished = true;
          visualOffset = { x: 0, y: 0 };
          this.listeners.finish?.();
        },
        addEventListener(type, fn) { this.listeners[type] = fn; }
      };
      animations.push(record);
      return record;
    }
  };
}

test('prefers-reduced-motion: reduce 时跳过所有动效且 FLIP 仍执行 DOM 变更', () => {
  const { motion } = loadMotion({ reduced: true });
  assert.equal(motion.reduced(), true);
  const el = fakeElement();
  assert.equal(motion.enter(el), null);
  assert.equal(motion.pulse(el), null);
  assert.equal(motion.nudge(el), null);
  assert.equal(el.animations.length, 0);

  let mutated = false;
  motion.flip([el], () => { mutated = true; el.setRect({ left: 100, top: 0, width: 100, height: 40 }); });
  assert.equal(mutated, true);
  assert.equal(el.animations.length, 0);
});

test('运行中切到 prefers-reduced-motion: reduce 会结束在途动画并保留终态', () => {
  const { motion, setReduced } = loadMotion({ reduced: false });
  const el = fakeElement();
  const anim = motion.enter(el, { y: 8 });
  assert.equal(anim.finished, false);
  setReduced(true);
  assert.equal(anim.finished, true);
  assert.equal(motion.enter(el, { y: 8 }), null);
});

test('同一元素同 key 的新动画会立即取消旧动画以保持可打断', () => {
  const { motion } = loadMotion({ reduced: false });
  const el = fakeElement();
  const first = motion.enter(el, { x: 16 });
  const second = motion.enter(el, { x: -16 });
  assert.equal(first.cancelled, true);
  assert.equal(second.cancelled, false);
  assert.equal(el.animations.length, 2);
});

test('FLIP 仅对实际移动的元素播放纯 transform 动画，并给主元素轻微抬升', () => {
  const { motion } = loadMotion({ reduced: false });
  const moved = fakeElement({ left: 0, top: 0, width: 200, height: 100 });
  const still = fakeElement({ left: 0, top: 120, width: 200, height: 100 });
  motion.flip([moved, still], () => {
    moved.setRect({ left: 260, top: 40, width: 200, height: 100 });
  }, { liftElement: moved });

  assert.equal(still.animations.length, 0);
  assert.equal(moved.animations.length, 1);
  assert.match(moved.animations[0].keyframes[0].transform, /translate3d\(-260px, -40px, 0\)/);
  assert.match(moved.animations[0].keyframes[1].transform, /scale\(1\.018\)/);
});

test('FLIP 连续被打断时先取消旧动画再测终点，从实时屏幕坐标丝滑接续不跳帧', () => {
  const { motion } = loadMotion({ reduced: false });
  const card = fakeElement({ left: 0, top: 0, width: 200, height: 100 });
  // 第一次移动：0 -> 200
  motion.flip([card], () => {
    card.setRect({ left: 200, top: 0, width: 200, height: 100 });
  }, { liftElement: card });
  // 模拟动画行进到屏幕 x = 34px（相对终点 200 偏移 -166px）时再次移动到 x = 300px
  card.setVisualOffset(-166, 0);
  motion.flip([card], () => {
    card.setRect({ left: 300, top: 0, width: 200, height: 100 });
  }, { liftElement: card });

  assert.equal(card.animations[0].cancelled, true);
  assert.equal(card.animations.length, 2);
  // 首帧应精确从 34 - 300 = -266px 接续，绝不跳到 200 - 300 = -100px
  assert.match(card.animations[1].keyframes[0].transform, /translate3d\(-266px, 0px, 0\)/);
});

test('无 Web Animations API 时所有原语静默降级不抛错', () => {
  const { motion } = loadMotion({ reduced: false });
  const plain = {};
  assert.equal(motion.enter(plain), null);
  assert.equal(motion.exit(plain), null);
  assert.equal(motion.pulse(plain), null);
  assert.equal(motion.nudge(plain), null);
  let ran = false;
  motion.flip([plain], () => { ran = true; });
  assert.equal(ran, true);
});
