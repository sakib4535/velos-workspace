'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { WORLD_WIDTH, WORLD_HEIGHT, MIN_ZOOM, MAX_ZOOM, screenToWorld, worldToScreen,
  zoomCamera, fitCamera, createCanvasController } = require('../quorum/canvas-space.js');

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);

function target() {
  const listeners = new Map();
  const attributes = new Map();
  const styles = new Map();
  const classes = new Set();
  const captures = new Set();
  const node = {
    style: { setProperty: (key, value) => styles.set(key, value) }, attributes, styles, classes,
    classList: { toggle: (key, enabled) => enabled ? classes.add(key) : classes.delete(key),
      add: (key) => classes.add(key), remove: (key) => classes.delete(key) },
    setAttribute: (key, value) => attributes.set(key, value),
    addEventListener(name, handler) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(handler); },
    removeEventListener(name, handler) { listeners.set(name, (listeners.get(name) || []).filter((fn) => fn !== handler)); },
    setPointerCapture: (id) => captures.add(id),
    hasPointerCapture: (id) => captures.has(id),
    releasePointerCapture: (id) => captures.delete(id),
    closest: () => null,
    dispatch(name, properties = {}) {
      const event = { type: name, button: 0, pointerId: 1, clientX: 500, clientY: 300, target: node,
        preventDefault() { this.prevented = true; }, stopPropagation() {}, ...properties };
      for (const handler of listeners.get(name) || []) handler(event);
      return event;
    }
  };
  return node;
}
function harness() {
  let rect = { left: 10, top: 20, width: 1000, height: 600 };
  const win = target();
  const stage = target();
  const world = target();
  const controls = new Map(['qCanvasZoomLabel', 'qCanvasZoomIn', 'qCanvasZoomOut', 'qCanvasFit', 'qCanvasReset', 'qCanvasPanBtn'].map((id) => [id, target()]));
  stage.getBoundingClientRect = () => rect;
  world.querySelectorAll = () => [];
  const controller = createCanvasController({ window: win, document: { getElementById: (id) => controls.get(id), querySelector: () => null }, stage, world });
  controller.bind();
  controller.setLive(true);
  return { controller, win, stage, world, controls, resize: (next) => { rect = { ...rect, ...next }; controller.resize(); } };
}

test('world fractions round-trip outside the initial canvas with a translated and scaled camera', () => {
  const camera = { x: -540, y: 80, scale: 0.67 };
  const rect = { left: 75, top: 120 };
  const screen = worldToScreen(camera, -2.5, 4.25, rect);
  const world = screenToWorld(camera, screen.x, screen.y, rect);
  near(world.x, -2.5);
  near(world.y, 4.25);
});

test('wheel zoom keeps the point under the pointer stationary even at zoom limits', () => {
  const camera = { x: -340, y: -250, scale: .7 };
  const anchor = { x: 320, y: 140 };
  const before = screenToWorld(camera, anchor.x, anchor.y);
  for (const factor of [1.2, .8, 100, .001]) {
    const next = zoomCamera(camera, factor, anchor);
    const after = worldToScreen(next, before.x, before.y);
    near(after.x, anchor.x);
    near(after.y, anchor.y);
    assert.ok(next.scale >= MIN_ZOOM && next.scale <= MAX_ZOOM);
  }
});

test('fit includes nodes at negative coordinates and centers their complete bounds', () => {
  const bounds = { x: -2400, y: 1800, width: 2000, height: 800 };
  const camera = fitCamera(bounds, 1200, 800);
  const center = worldToScreen(camera, (bounds.x + bounds.width / 2) / WORLD_WIDTH,
    (bounds.y + bounds.height / 2) / WORLD_HEIGHT);
  near(center.x, 600);
  near(center.y, 400);
  const left = worldToScreen(camera, bounds.x / WORLD_WIDTH, bounds.y / WORLD_HEIGHT);
  assert.ok(left.x >= 64 && left.y >= 64);
});

test('blank drag pans only the local camera and stops after capture loss', () => {
  const h = harness();
  const before = h.controller.worldToScreen(.5, .5);
  h.stage.dispatch('pointerdown', { clientX: 200, clientY: 200 });
  h.stage.dispatch('pointermove', { clientX: 410, clientY: 120 });
  const after = h.controller.worldToScreen(.5, .5);
  near(after.x - before.x, 210);
  near(after.y - before.y, -80);
  h.stage.dispatch('lostpointercapture');
  h.stage.dispatch('pointermove', { clientX: 700, clientY: 700 });
  assert.deepEqual(h.controller.worldToScreen(.5, .5), after);
  assert.equal(h.stage.classes.has('q-canvas-panning'), false);
});

test('two-finger pinch zooms around its midpoint while the midpoint can also pan', () => {
  const h = harness();
  h.stage.dispatch('pointerdown', { pointerId: 1, clientX: 310, clientY: 320 });
  h.stage.dispatch('pointerdown', { pointerId: 2, clientX: 710, clientY: 320 });
  const world = h.controller.screenToWorld(510, 320);
  h.stage.dispatch('pointermove', { pointerId: 2, clientX: 910, clientY: 320 });
  const anchor = h.controller.worldToScreen(world.x, world.y);
  near(anchor.x, 610);
  near(anchor.y, 320);
  assert.equal(h.controls.get('qCanvasZoomLabel').textContent, '71%');
  h.stage.dispatch('pointerup', { pointerId: 2 });
  h.stage.dispatch('pointerup', { pointerId: 1 });
  assert.equal(h.stage.classes.has('q-canvas-panning'), false);
});

test('tool frames keep wheel input, canvas wheel input zooms, and input shortcuts are ignored', () => {
  const h = harness();
  const before = h.controller.worldToScreen(.6, .5);
  const tool = { closest: (selector) => selector.includes('.q-tool-screen') ? {} : null };
  const inside = h.stage.dispatch('wheel', { deltaY: -100, target: tool });
  assert.equal(inside.prevented, undefined);
  assert.deepEqual(h.controller.worldToScreen(.6, .5), before);
  const canvas = h.stage.dispatch('wheel', { deltaY: -100 });
  assert.equal(canvas.prevented, true);
  assert.notDeepEqual(h.controller.worldToScreen(.6, .5), before);
  const zoom = h.controls.get('qCanvasZoomLabel').textContent;
  h.win.dispatch('keydown', { key: '+', target: { closest: () => ({}) } });
  assert.equal(h.controls.get('qCanvasZoomLabel').textContent, zoom);
});

test('resizing the sidebar preserves the world point at the center and leaving cancels touch state', () => {
  const h = harness();
  const before = h.controller.center();
  h.resize({ width: 1400, height: 700 });
  near(h.controller.center().x, before.x);
  near(h.controller.center().y, before.y);
  h.stage.dispatch('pointerdown');
  h.controller.setLive(false);
  const transform = h.world.style.transform;
  h.stage.dispatch('pointermove', { clientX: 800, clientY: 100 });
  h.win.dispatch('keydown', { key: '+' });
  assert.equal(h.world.style.transform, transform);
  assert.equal(h.controller.isPanning(), false);
});

test('fit inverts the current transform so moved tool screens remain visible after repeated fitting', () => {
  const h = harness();
  const card = { getBoundingClientRect() {
    const start = h.controller.worldToScreen(-1.2, 2.2);
    const end = h.controller.worldToScreen(-.8, 2.6);
    return { left: start.x, top: start.y, right: end.x, bottom: end.y, width: end.x - start.x, height: end.y - start.y };
  } };
  h.world.querySelectorAll = () => [card];
  h.controller.fit();
  const first = h.controller.center();
  near(first.x, -1);
  near(first.y, 2.4);
  h.controller.fit();
  near(h.controller.center().x, first.x);
  near(h.controller.center().y, first.y);
});

function appHarness() {
  const h = harness();
  const elements = new Map();
  const sent = [];
  const context = vm.createContext({
    window: { QUORUM_CONFIG: {}, QuorumCanvas: h.controller },
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, target()); return elements.get(id); } },
    location: new URL('http://localhost:8788/quorum/'), URL, URLSearchParams,
    performance: { now: () => 100000 }, setTimeout, clearTimeout, setInterval, clearInterval, console, sent
  });
  const source = fs.readFileSync(path.join(__dirname, '../quorum/quorum-app.js'), 'utf8')
    .replace(/\ninitJoinScreen\(\);\s*bindControls\(\);\s*$/, '');
  vm.runInContext(source, context);
  vm.runInContext(`send = (message) => { sent.push(message); return true; };
    S.joined = true; S.selfId = 'self';
    S.room = { hostId: 'host', groups: [], participants: [
      { id: 'self', box: { x: .2, y: .2 } }, { id: 'other', box: { x: .5, y: .5 } }
    ] };
    E.qStage.querySelectorAll = () => [];`, context);
  const app = vm.runInContext('({ S, bindBoxEvents, stagePointToNormalized })', context);
  function box(id) {
    const el = target();
    el.dataset = { id };
    const profile = target();
    el.querySelector = () => profile;
    app.bindBoxEvents(el);
    return el;
  }
  return { ...h, ...app, sent, box };
}

test('participants move their own tile beyond the old viewport without moving other people', () => {
  const h = appHarness();
  const other = h.box('other');
  other.dispatch('pointerdown');
  assert.equal(h.S.drag, null);
  const self = h.box('self');
  const start = h.controller.worldToScreen(.2, .2);
  self.dispatch('pointerdown', { clientX: start.x, clientY: start.y });
  const end = h.controller.worldToScreen(-1.3, 2.4);
  self.dispatch('pointermove', { clientX: end.x, clientY: end.y });
  self.dispatch('pointerup', { clientX: end.x, clientY: end.y });
  assert.equal(h.sent.at(-1).type, 'host:move');
  assert.equal(h.sent.at(-1).peerId, 'self');
  near(h.sent.at(-1).x, -1.3);
  near(h.sent.at(-1).y, 2.4);
});

test('camera-aware dragging preserves where the tile was grabbed and canceled drops keep its last position', () => {
  const h = appHarness();
  const self = h.box('self');
  const start = h.controller.worldToScreen(.18, .19);
  self.dispatch('pointerdown', { clientX: start.x, clientY: start.y });
  const end = h.controller.worldToScreen(.3, .4);
  self.dispatch('pointermove', { clientX: end.x, clientY: end.y });
  near(h.S.drag.lastPosition.x, .32);
  near(h.S.drag.lastPosition.y, .41);
  self.dispatch('pointercancel', { clientX: 0, clientY: 0 });
  near(h.sent.at(-1).x, .32);
  near(h.sent.at(-1).y, .41);
  assert.equal(h.S.drag, null);
});
