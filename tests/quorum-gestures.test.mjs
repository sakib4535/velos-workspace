import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { createGestureTracker, frameSize } from '../quorum/gesture-tracker.mjs';

const source = (await readFile(new URL('../quorum/quorum-app.js', import.meta.url), 'utf8'))
  .replace(/\ninitJoinScreen\(\);\s*bindControls\(\);\s*$/, '');

function harness({ rawPoses = true } = {}) {
  let now = 2000;
  const sent = [];
  const elements = new Map();
  const element = () => ({
    textContent: '', hidden: true, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 600 }; }
  });
  const context = vm.createContext({
    window: { QUORUM_CONFIG: {} }, location: { hostname: 'localhost', host: 'localhost:8788', protocol: 'http:' },
    document: { hidden: false, getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } },
    navigator: {}, performance: { now: () => now }, URL, URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame() { return 1; }, cancelAnimationFrame() {}, console
  });
  vm.runInContext(source, context);
  context.sent = sent;
  vm.runInContext(`
    send = (message) => { sent.push(message); return true; };
    S.joined = true;
    S.selfId = 'self';
    S.room = { hostId: 'host', ballot: { open: true }, participants: [{ id: 'self', groupId: 'g', vote: null, handRaised: false }] };
    S.cameraTrack = { readyState: 'live' };
    E.qCamVideo.readyState = 2;
    E.qCamVideo.videoWidth = 960;
    E.qCamVideo.videoHeight = 540;
    E.qCamVideo.currentTime = 1;
  `, context);
  if (rawPoses) vm.runInContext("recognizeGesture = (landmarks) => landmarks?.pose || 'none';", context);
  const api = vm.runInContext('({ S, E, CFG, recognizeGesture, processGestureSample, gestureLoop, startGestureEngine, stopGestureEngine, resetGestureTracking, updateHostHandDrag })', context);
  return {
    ...api, context, sent,
    sample(pose, advance = 50) { now += advance; api.processGestureSample(pose === null ? null : { pose }, now); },
    advance(ms) { now += ms; },
    run(code) { return vm.runInContext(code, context); }
  };
}

function landmarks({ extended = [], thumb = 'folded' } = {}) {
  const points = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.6, z: 0 }));
  points[0] = { x: 0.5, y: 0.85, z: 0 };
  for (const [finger, mcp, x] of [['index', 5, 0.42], ['middle', 9, 0.5], ['ring', 13, 0.58], ['pinky', 17, 0.66]]) {
    const ys = extended.includes(finger) ? [0.65, 0.45, 0.3, 0.15] : [0.65, 0.5, 0.6, 0.7];
    ys.forEach((y, offset) => { points[mcp + offset] = { x, y, z: 0 }; });
  }
  const thumbs = {
    folded: [[0.37, 0.7], [0.33, 0.63], [0.36, 0.63], [0.39, 0.68]],
    up: [[0.3, 0.75], [0.3, 0.6], [0.3, 0.45], [0.3, 0.3]],
    down: [[0.25, 0.7], [0.25, 0.82], [0.25, 0.94], [0.25, 1.06]],
    sideways: [[0.35, 0.7], [0.25, 0.7], [0.15, 0.7], [0.05, 0.7]]
  };
  thumbs[thumb].forEach(([x, y], index) => { points[index + 1] = { x, y, z: 0 }; });
  return points;
}

test('classifies supported poses for either mirrored hand and rejects invalid landmarks', () => {
  const h = harness({ rawPoses: false });
  const cases = [
    [{}, 'fist'], [{ extended: ['index', 'middle', 'ring', 'pinky'] }, 'open'],
    [{ extended: ['index', 'middle'] }, 'peace'], [{ thumb: 'up' }, 'thumbsup'],
    [{ thumb: 'down' }, 'thumbsdown'], [{ thumb: 'sideways' }, 'none'],
    [{ extended: ['pinky'], thumb: 'up' }, 'shaka']
  ];
  for (const [pose, expected] of cases) {
    const hand = landmarks(pose);
    assert.equal(h.recognizeGesture(hand), expected);
    assert.equal(h.recognizeGesture(hand.map((point) => ({ ...point, x: 1 - point.x }))), expected);
  }
  assert.equal(h.recognizeGesture(null), 'none');
  assert.equal(h.recognizeGesture(landmarks().map((point) => ({ ...point, x: NaN }))), 'none');
  assert.equal(h.recognizeGesture(Array.from({ length: 21 }, () => ({ x: 0, y: 0 }))), 'none');
});

test('votes once per held pose and rearms after release, including after an external vote reset', () => {
  const h = harness();
  for (let i = 0; i < 35; i++) h.sample('thumbsup');
  assert.equal(h.sent.length, 1);
  h.sample(null);
  h.sample(null);
  h.advance(1000);
  for (let i = 0; i < 3; i++) h.sample('thumbsup');
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].choice, 'yes');
});

test('two pose samples followed by no hand cannot inherit a stale voting majority', () => {
  const h = harness();
  h.sample('thumbsup'); h.sample('thumbsup'); h.sample(null);
  assert.equal(h.S.gesture.stable, 'none');
  assert.equal(h.sent.length, 0);
  assert.equal(h.S.gesture.openSince, 0);
});

test('a held vote becomes actionable when the ballot opens without requiring a release', () => {
  const h = harness();
  h.S.room.ballot.open = false;
  for (let i = 0; i < 4; i++) h.sample('thumbsup');
  assert.equal(h.sent.length, 0);
  h.S.room.ballot.open = true;
  h.advance(1000);
  h.sample('thumbsup');
  assert.equal(h.sent.length, 1);
});

test('open palm toggles once per hold, releases, and does not fire after camera loss', () => {
  const h = harness();
  for (let i = 0; i < 45; i++) h.sample('open');
  assert.equal(h.sent.filter((message) => message.type === 'hand').length, 1);
  h.S.room.participants[0].handRaised = true;
  h.sample(null); h.sample(null);
  for (let i = 0; i < 30; i++) h.sample('open');
  assert.equal(h.sent.filter((message) => message.type === 'hand').length, 2);
  assert.equal(h.sent.at(-1).raised, false);
  h.sample(null);
  for (let i = 0; i < 3; i++) h.sample('open');
  h.advance(1600);
  h.sample(null);
  assert.equal(h.sent.length, 2);
});

test('dropping a participant with an open palm does not also raise a hand', () => {
  const h = harness();
  h.S.handDrag = { el: { classList: { remove() {} } }, moved: false };
  h.sample('open');
  for (let i = 0; i < 45; i++) h.sample('open');
  assert.equal(h.sent.length, 0);
});

test('detector runs at bounded frequency and never queues a second camera frame', async () => {
  const h = harness();
  let finish;
  let calls = 0;
  h.S.gesture.active = true;
  h.S.gesture.tracker = { detect() { calls++; return new Promise((resolve) => { finish = resolve; }); } };
  h.gestureLoop();
  h.E.qCamVideo.currentTime = 2;
  h.advance(100);
  h.gestureLoop();
  assert.equal(calls, 1);
  finish(null);
  await new Promise((resolve) => setImmediate(resolve));
  h.gestureLoop();
  assert.equal(calls, 2);
  finish(null);
  await new Promise((resolve) => setImmediate(resolve));
  h.E.qCamVideo.currentTime = 3;
  h.advance(1);
  h.gestureLoop();
  assert.equal(calls, 2);
});

test('late inference from a stopped engine or old camera cannot fire actions', async () => {
  const h = harness();
  let finish;
  h.S.gesture.active = true;
  h.S.gesture.buffer = ['thumbsup', 'thumbsup'];
  h.S.gesture.tracker = { detect() { return new Promise((resolve) => { finish = resolve; }); }, close() {} };
  h.gestureLoop();
  h.stopGestureEngine({ dispose: true });
  finish({ pose: 'thumbsup' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sent.length, 0);
  assert.equal(h.S.gesture.tracker, null);
});

test('a canceled initialization cannot restart tracking and a repeated start reuses the model', async () => {
  const h = harness();
  let finish;
  let closes = 0;
  h.S.gesture.initPromise = new Promise((resolve) => { finish = resolve; });
  const firstStart = h.startGestureEngine();
  h.stopGestureEngine();
  const secondStart = h.startGestureEngine();
  finish({ detect: async () => null, close() { closes++; } });
  await Promise.all([firstStart, secondStart]);
  assert.equal(h.S.gesture.active, true);
  assert.equal(closes, 0);
  const tracker = h.S.gesture.tracker;
  h.stopGestureEngine();
  await h.startGestureEngine();
  assert.equal(h.S.gesture.tracker, tracker);
  h.stopGestureEngine({ dispose: true });
  assert.equal(closes, 1);
});

test('a connection loss during initialization does not leave loading latched', async () => {
  const h = harness();
  let finish;
  h.S.gesture.initPromise = new Promise((resolve) => { finish = resolve; });
  const start = h.startGestureEngine();
  h.S.joined = false;
  finish({ detect: async () => null, close() {} });
  await start;
  assert.equal(h.S.gesture.active, false);
  assert.equal(h.S.gesture.loading, false);
  h.S.joined = true;
  await h.startGestureEngine();
  assert.equal(h.S.gesture.active, true);
  h.stopGestureEngine({ dispose: true });
});

test('a failed canceled initializer is cleared so the next retry can reload it', async () => {
  const h = harness();
  let reject;
  h.S.gesture.initPromise = new Promise((_, failed) => { reject = failed; });
  const start = h.startGestureEngine();
  h.stopGestureEngine();
  reject(new Error('Network unavailable'));
  await start;
  assert.equal(h.S.gesture.initPromise, null);
  assert.equal(h.S.gesture.wanted, true);
});

test('camera stalls release hand manipulation and rear camera cursor uses its visible orientation', () => {
  const h = harness({ rawPoses: false });
  h.S.room.hostId = 'self';
  h.S.cameraFacingMode = 'environment';
  const hand = landmarks();
  hand[9].x = 0.2;
  h.updateHostHandDrag(hand, 'open', 2000);
  assert.equal(h.E.qHandCursor.style.left, '200px');
  h.S.cameraFacingMode = 'user';
  h.resetGestureTracking();
  h.updateHostHandDrag(hand, 'open', 2000);
  assert.equal(h.E.qHandCursor.style.left, '800px');
  h.S.gesture.active = true;
  h.S.gesture.lastSampleAt = 1000;
  h.S.gesture.lastVideoTime = 1;
  h.S.gesture.openSince = 1000;
  h.gestureLoop();
  assert.equal(h.S.gesture.openSince, 0);
  assert.equal(h.E.qHandCursor.hidden, true);
});

test('camera frames are downscaled proportionally without upscaling', () => {
  assert.deepEqual(frameSize({ videoWidth: 960, videoHeight: 540 }, 480), { width: 480, height: 270 });
  assert.deepEqual(frameSize({ videoWidth: 320, videoHeight: 240 }, 480), { width: 320, height: 240 });
  assert.deepEqual(frameSize({ videoWidth: 1080, videoHeight: 1920 }, 480), { width: 480, height: 853 });
});

const fakeBundleUrl = 'data:text/javascript,' + encodeURIComponent(`
  export const FilesetResolver = { forVisionTasks: async () => ({}) };
  export const HandLandmarker = { createFromOptions: async () => ({
    detectForVideo: (_frame, timestamp) => ({ landmarks: [[{ x: timestamp, y: 0.25 }]] }),
    close() {}
  }) };
`);

async function trackerEnvironment(values, callback) {
  const original = Object.fromEntries(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  try { await callback(); }
  finally {
    for (const key of Object.keys(values)) {
      if (original[key]) Object.defineProperty(globalThis, key, original[key]);
      else delete globalThis[key];
    }
  }
}

function trackerConfig() { return { bundleUrl: fakeBundleUrl, wasmUrl: 'test', modelUrl: 'test', inputWidth: 480 }; }
function fallbackDocument(onDraw = () => {}) {
  return { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: onDraw }) }) };
}

test('worker inference transfers resized frames, uses a classic worker, and releases on close', async () => {
  let worker;
  let resize;
  let transferred;
  await trackerEnvironment({
    Worker: class {
      constructor(url, options) { assert.equal(options, undefined); assert.match(url.pathname, /gesture-worker\.js$/); worker = this; }
      postMessage(message, transfer) {
        if (message.type === 'detect') transferred = transfer;
        queueMicrotask(() => this.onmessage({ data: { id: message.id, landmarks: message.type === 'detect' ? [{ x: 0.3, y: 0.4 }] : null } }));
      }
      terminate() { this.terminated = true; }
    },
    OffscreenCanvas: class {},
    createImageBitmap: async (_video, options) => { resize = options; return { close() {} }; },
    document: fallbackDocument()
  }, async () => {
    const tracker = await createGestureTracker(trackerConfig());
    assert.deepEqual(await tracker.detect({ videoWidth: 960, videoHeight: 540 }, 2000), [{ x: 0.3, y: 0.4 }]);
    assert.equal(resize.resizeWidth, 480);
    assert.equal(resize.resizeHeight, 270);
    assert.equal(transferred.length, 1);
    tracker.close();
    assert.equal(worker.terminated, true);
    assert.equal(await tracker.detect({ videoWidth: 960, videoHeight: 540 }, 2100), null);
  });
});

test('unsupported workers fall back to resized browser inference', async () => {
  let drawn;
  await trackerEnvironment({
    Worker: undefined, OffscreenCanvas: undefined, createImageBitmap: undefined,
    document: fallbackDocument((...args) => { drawn = args; })
  }, async () => {
    const tracker = await createGestureTracker(trackerConfig());
    const result = await tracker.detect({ videoWidth: 960, videoHeight: 540 }, 2000);
    assert.equal(result[0].x, 2000);
    assert.deepEqual(drawn.slice(1), [0, 0, 480, 270]);
    tracker.close();
  });
});

test('a worker failure after initialization switches to browser inference', async () => {
  let worker;
  await trackerEnvironment({
    Worker: class {
      constructor() { worker = this; }
      postMessage(message) { queueMicrotask(() => this.onmessage({ data: { id: message.id } })); }
      terminate() { this.terminated = true; }
    },
    OffscreenCanvas: class {}, createImageBitmap: async () => ({ close() {} }),
    document: fallbackDocument()
  }, async () => {
    const tracker = await createGestureTracker(trackerConfig());
    worker.onerror(new Error('GPU context lost'));
    const result = await tracker.detect({ videoWidth: 960, videoHeight: 540 }, 2000);
    assert.equal(result[0].x, 2000);
    assert.equal(worker.terminated, true);
    tracker.close();
  });
});
