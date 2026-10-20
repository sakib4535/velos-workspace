'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const clientSource = fs.readFileSync(path.join(__dirname, '..', 'quorum', 'quorum-app.js'), 'utf8');

function createClient({
  url = 'http://localhost:8788/quorum/', config = {},
  useRealApplyState = false,
  fetch: fetchImplementation = async () => ({ ok: false })
} = {}) {
  let nextTimer = 1;
  const timers = new Map();
  const elements = new Map();
  const sockets = [];
  const logs = [];
  const storage = new Map();
  const location = new URL(url);
  let now = 1000000;
  class ControlledDate extends Date {
    static now() { return now; }
  }
  const makeElement = () => {
    const listeners = new Map();
    return {
    value: '', disabled: false, hidden: false, innerHTML: '', textContent: '',
    dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, remove() {}, focus() {},
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatch(type, event = {}) { for (const listener of listeners.get(type) || []) listener(event); },
    querySelectorAll: () => [], querySelector: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    play: () => Promise.resolve()
    };
  };
  const addTimer = (fn, delay, interval = false) => {
    const id = nextTimer++;
    timers.set(id, { fn, delay, interval });
    return id;
  };
  const clock = {
    timers,
    now: () => now,
    advance: (ms) => { now += ms; },
    get: (id) => timers.get(id),
    fire(id) {
      const timer = timers.get(id);
      assert.ok(timer, `Timer ${id} must be scheduled`);
      if (!timer.interval) timers.delete(id);
      return timer.fn();
    }
  };

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    constructor(socketUrl) {
      this.url = socketUrl;
      this.readyState = FakeWebSocket.CONNECTING;
      this.listeners = new Map();
      this.sent = [];
      sockets.push(this);
    }
    addEventListener(type, callback, options = {}) {
      const listeners = this.listeners.get(type) || [];
      listeners.push({ callback, once: options.once });
      this.listeners.set(type, listeners);
    }
    emit(type, payload = {}) {
      if (type === 'open') this.readyState = FakeWebSocket.OPEN;
      if (type === 'close') this.readyState = FakeWebSocket.CLOSED;
      for (const listener of [...(this.listeners.get(type) || [])]) {
        if (listener.once) {
          this.listeners.set(type, this.listeners.get(type).filter((item) => item !== listener));
        }
        listener.callback(payload);
      }
    }
    send(data) {
      if (this.readyState !== FakeWebSocket.OPEN) throw new Error('Socket is closed');
      this.sent.push(JSON.parse(data));
    }
    close() {
      if (this.readyState !== FakeWebSocket.CLOSED) this.emit('close');
    }
  }

  class FakeMediaStream {
    constructor() { this.tracks = []; }
    getTracks() { return this.tracks; }
    addTrack(track) { this.tracks.push(track); }
    removeTrack(track) { this.tracks = this.tracks.filter((item) => item !== track); }
  }

  class FakePeerConnection {
    constructor(rtcConfig) {
      this.config = rtcConfig;
      this.connectionState = 'new';
      this.signalingState = 'stable';
      this.remoteDescription = null;
      this.localDescription = null;
      this.transceivers = [];
      this.calls = [];
      this.candidates = [];
      this.restarts = 0;
    }
    addTransceiver(kind) {
      const sender = { track: null, async replaceTrack(track) { this.track = track; } };
      const transceiver = { sender, receiver: { track: { kind } } };
      this.transceivers.push(transceiver);
      return transceiver;
    }
    getSenders() { return this.transceivers.map((item) => item.sender); }
    getTransceivers() { return this.transceivers; }
    async setLocalDescription() {
      const type = this.signalingState === 'have-remote-offer' ? 'answer' : 'offer';
      this.calls.push(`local:${type}`);
      this.localDescription = { type, sdp: `${type}-sdp` };
      this.signalingState = type === 'answer' ? 'stable' : 'have-local-offer';
    }
    async setRemoteDescription(description) {
      this.calls.push(`remote:${description.type}`);
      this.remoteDescription = description;
      this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
    }
    async addIceCandidate(candidate) {
      this.calls.push(`ice:${candidate.candidate}`);
      this.candidates.push(candidate);
    }
    restartIce() { this.restarts += 1; }
    getConfiguration() { return { ...this.config }; }
    setConfiguration(rtcConfig) { this.config = rtcConfig; }
    close() { this.connectionState = 'closed'; }
  }

  const quietConsole = { error: (...args) => logs.push(args), log() {}, warn() {} };
  const context = vm.createContext({
    window: { QUORUM_CONFIG: config, addEventListener() {} }, location, URL, URLSearchParams,
    document: {
      hidden: false,
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
      },
      createElement: makeElement,
      querySelectorAll: () => [], addEventListener() {},
      body: makeElement()
    },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value)
    },
    sessionStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key)
    },
    navigator: { onLine: true },
    setTimeout: (fn, delay) => addTimer(fn, delay), clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, delay) => addTimer(fn, delay, true), clearInterval: (id) => timers.delete(id),
    Math: Object.assign(Object.create(Math), { random: () => 0 }),
    console: quietConsole, Date: ControlledDate, performance: { now: () => now },
    fetch: fetchImplementation, AbortController,
    WebSocket: FakeWebSocket, MediaStream: FakeMediaStream, RTCPeerConnection: FakePeerConnection,
    RTCSessionDescription: class { constructor(value) { Object.assign(this, value); } },
    RTCIceCandidate: class { constructor(value) { Object.assign(this, value); } }
  });
  // Keep all production functions, excluding the two UI boot calls. Rendering
  // is replaced below so lifecycle tests exercise the real connection logic.
  const sourceWithoutBoot = clientSource.replace(/\ninitJoinScreen\(\);\s*bindControls\(\);\s*$/, '\n');
  assert.notEqual(sourceWithoutBoot, clientSource, 'Client boot calls must be excluded from the harness');
  vm.runInContext(sourceWithoutBoot + `
    toast = () => {};
    finishHostHandDrag = () => {};
    renderTopbar = () => {};
    ${useRealApplyState ? `
      renderStage = () => {};
      renderFacil = () => {};
      renderRemoteControlUi = () => {};
      emitDiffToasts = () => {};
    ` : 'applyState = (room) => { S.room = room; };'}
    enterSpace = () => {};
    globalThis.client = {
      S, E, getWebSocketUrls, connectSocket, connectSocketAt, joinRoom,
      sendJoin, tryReconnect, onSocketMessage, onSocketClose, startHeartbeat,
      ensurePeer, handleSignal, closePeer, restartPeerIce, recoverPeerIce, renderStage, loadRtcConfig,
      bindBoxEvents, bindGroupEvents, bindControls, attachRemoteStream, enableRemoteAudio,
      syncMediaConnectionUi, retryMediaConnections, requestLeaveSpace
    };
  `, context, { filename: 'quorum-app.js' });
  return { ...context.client, clock, elements, sockets, logs, context, WebSocket: FakeWebSocket };
}

async function flushMicrotasks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function setJoinedRoom(client, selfId, peerId) {
  client.S.selfId = selfId;
  client.S.joined = true;
  client.S.roomId = 'cedar-k4';
  client.S.room = { id: 'cedar-k4', participants: [{ id: selfId }, { id: peerId }] };
  client.S.socket = new client.WebSocket('ws://localhost:8788/quorum-space');
  client.S.socket.readyState = client.WebSocket.OPEN;
}

function preparePlaybackStage(client) {
  const boxes = new Map();
  const media = new Map();
  for (const id of ['self', 'peer']) {
    const makeMedia = () => ({
      muted: true, paused: true, srcObject: null, plays: 0,
      play() { this.plays += 1; this.paused = false; return Promise.resolve(); },
      pause() { this.paused = true; }
    });
    const video = makeMedia();
    const audio = makeMedia();
    const classes = new Set();
    const nodes = new Map([['video', video], ['audio', audio]]);
    media.set(id, { video, audio, classes });
    boxes.set(id, {
      dataset: { id }, style: {},
      classList: { add() {}, remove() {}, toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      } },
      remove() { boxes.delete(id); },
      querySelectorAll: (selector) => selector === 'video, audio' ? [video, audio] : [],
      querySelector(selector) {
        if (!nodes.has(selector)) nodes.set(selector, {
          textContent: '', hidden: false, setAttribute() {},
          classList: { toggle() {} }
        });
        return nodes.get(selector);
      }
    });
  }
  client.E.qStage.querySelector = (selector) => boxes.get(selector.match(/data-id="([^"]+)"/)?.[1]) || null;
  client.E.qStage.querySelectorAll = (selector) => selector === '.q-box' ? [...boxes.values()] : [];
  client.S.selfId = 'self';
  client.S.room = {
    id: 'cedar-k4', hostId: 'self', groups: [], ballot: { open: false },
    participants: ['self', 'peer'].map((id) => ({
      id, name: id, micOn: true, camOn: true, handRaised: false, box: { x: 0, y: 0 }
    }))
  };
  return { boxes, media };
}

function makePointerElement(id = '') {
  const listeners = new Map();
  const children = new Map();
  const classes = new Set();
  const capturedPointers = new Set();
  const element = {
    dataset: { id }, style: {}, children, classes,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle(name, force = !classes.has(name)) {
        if (force) classes.add(name);
        else classes.delete(name);
        return force;
      }
    },
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    querySelector: (selector) => children.get(selector) || null,
    closest: () => null,
    setPointerCapture: (pointerId) => capturedPointers.add(pointerId),
    hasPointerCapture: (pointerId) => capturedPointers.has(pointerId),
    releasePointerCapture: (pointerId) => capturedPointers.delete(pointerId),
    dispatch(type, properties = {}) {
      const event = {
        type, pointerId: 7, button: 0, target: element,
        preventDefault() {}, stopPropagation() {}, ...properties
      };
      for (const callback of listeners.get(type) || []) callback(event);
    }
  };
  return element;
}

function prepareHostDrag(client) {
  setJoinedRoom(client, 'self', 'peer');
  client.S.room.hostId = 'self';
  client.S.room.participants.forEach((participant) => { participant.box = { x: 0.2, y: 0.2 }; });
  client.S.room.groups = [{ id: 'group-a', x: 0.6, y: 0.6, w: 0.4, h: 0.4 }];
  const box = makePointerElement('peer');
  box.children.set('.q-profile-trigger', makePointerElement());
  const group = makePointerElement('group-a');
  const head = makePointerElement();
  head.children.set('.q-group-name', makePointerElement());
  group.children.set('.q-group-head', head);
  group.children.set('.q-group-x', makePointerElement());
  client.E.qStage.getBoundingClientRect = () => ({ left: 10, top: 20, width: 1000, height: 500 });
  client.E.qStage.querySelectorAll = (selector) => selector === '.q-group' ? [group] : [];
  client.E.qStage.querySelector = (selector) => selector.includes('group-a') ? group : null;
  return { box, group, head };
}

for (const [description, url, expected] of [
  ['local preview falls back to the Node server', 'http://localhost:5500/quorum/', ['ws://localhost:5500/quorum-space', 'ws://localhost:8788/quorum-space']],
  ['Node localhost uses its own server', 'http://localhost:8788/quorum/', ['ws://localhost:8788/quorum-space']],
  ['LAN IP keeps rooms on the same server', 'http://192.168.1.8:8788/quorum/', ['ws://192.168.1.8:8788/quorum-space']],
  ['private 10.x IP keeps rooms on the same server', 'http://10.0.0.8:8788/quorum/', ['ws://10.0.0.8:8788/quorum-space']],
  ['private 172.x IP keeps rooms on the same server', 'http://172.31.0.8:8788/quorum/', ['ws://172.31.0.8:8788/quorum-space']],
  ['local network hostname keeps rooms on the same server', 'http://studio.local:8788/quorum/', ['ws://studio.local:8788/quorum-space']],
  ['custom Render deployment keeps rooms on its own server', 'https://my-quorum.onrender.com/quorum/', ['wss://my-quorum.onrender.com/quorum-space']],
  ['public static hosting can reach the shared backend', 'https://velos.example/quorum/', ['wss://velos.example/quorum-space', 'wss://velos-workspace.onrender.com/quorum-space']]
]) {
  test(`endpoint selection: ${description}`, () => {
    const client = createClient({ url });
    assert.deepEqual(Array.from(client.getWebSocketUrls()), expected);
  });
}

test('an explicit backend overrides same-origin and shared endpoint discovery', () => {
  const client = createClient({
    url: 'http://localhost:5500/quorum/',
    config: { wsUrl: 'wss://dedicated.example/quorum-space' }
  });
  client.S.preferredWsUrl = 'wss://old.example/quorum-space';
  assert.deepEqual(Array.from(client.getWebSocketUrls()), ['wss://dedicated.example/quorum-space']);
});

test('room admission pins reconnects to the server that owns the room', async () => {
  const client = createClient({ url: 'https://velos.example/quorum/' });
  client.S.joining = true;
  client.S.roomId = 'cedar-k4';
  const pending = client.connectSocket();
  client.sockets[0].emit('error');
  await flushMicrotasks();
  const roomSocket = client.sockets[1];
  assert.equal(roomSocket.url, 'wss://velos-workspace.onrender.com/quorum-space');
  roomSocket.emit('open');
  await pending;
  await client.onSocketMessage({ data: JSON.stringify({
    type: 'joined', selfId: 'self', resumeToken: 'resume-token',
    room: { id: 'cedar-k4', participants: [{ id: 'self' }] }
  }) });
  client.S.preferredWsUrl = 'wss://velos.example/quorum-space';
  roomSocket.emit('close');
  assert.deepEqual(Array.from(client.getWebSocketUrls()), [roomSocket.url]);
  const reconnecting = client.clock.fire(client.S.reconnectTimer);
  assert.equal(client.sockets[2].url, roomSocket.url);
  client.sockets[2].emit('error');
  await reconnecting;
  assert.equal(client.sockets.length, 3, 'A room reconnect must not create a separate room on a fallback server');
  assert.ok(client.clock.get(client.S.reconnectTimer));
});

test('a close before the WebSocket handshake rejects and cleans the pending connection', async () => {
  const client = createClient();
  const pending = client.connectSocketAt('ws://localhost:8788/quorum-space');
  client.sockets[0].emit('close');
  await assert.rejects(pending, /closed before|Connection/i);
  assert.equal(client.S.socket, null);
  assert.equal(client.S.cancelConnect, null);
  assert.equal(client.clock.timers.size, 0);
});

test('initial join failure tries the local backend and re-enables the join controls', async () => {
  const client = createClient({ url: 'http://localhost:5500/quorum/' });
  const joining = client.joinRoom('cedar-k4', 'Sam', false, {});
  assert.equal(client.E.qJoinBtn.disabled, true);
  client.sockets[0].emit('error');
  await flushMicrotasks();
  assert.equal(client.sockets.length, 2);
  assert.equal(client.sockets[1].url, 'ws://localhost:8788/quorum-space');
  client.sockets[1].emit('error');
  await joining;
  assert.equal(client.S.joining, false);
  assert.equal(client.S.connecting, false);
  assert.equal(client.S.socket, null);
  assert.equal(client.E.qJoinBtn.disabled, false);
  assert.equal(client.E.qOpenBtn.disabled, false);
  assert.match(client.E.qJoinStatus.innerHTML, /connection|unavailable|server/i);
  assert.ok(client.clock.get(client.S.probeTimer), 'Reachability checking resumes after failure');
});

test('an opened socket without a joined acknowledgement retries after its join timeout', async () => {
  const client = createClient();
  const joining = client.joinRoom('cedar-k4', 'Sam', false, {});
  client.sockets[0].emit('open');
  await joining;
  assert.equal(client.S.joined, false);
  assert.equal(client.S.joining, true);
  assert.equal(client.sockets[0].sent[0].type, 'join');
  assert.equal(client.clock.get(client.S.joinTimer).delay, 12000);
  client.clock.fire(client.S.joinTimer);
  assert.equal(client.S.socket, null);
  assert.ok(client.clock.get(client.S.reconnectTimer));
  assert.equal(client.E.qJoinBtn.disabled, true);
});

test('reconnect backoff survives socket opens and resets only after room admission', async () => {
  const client = createClient();
  client.S.joining = true;
  client.S.roomId = 'cedar-k4';
  client.tryReconnect();
  assert.equal(client.clock.get(client.S.reconnectTimer).delay, 750);
  const firstAttempt = client.clock.fire(client.S.reconnectTimer);
  client.sockets[0].emit('open');
  await firstAttempt;
  assert.equal(client.S.reconnectAttempts, 1);
  client.sockets[0].emit('close');
  assert.equal(client.clock.get(client.S.reconnectTimer).delay, 1500);
  const secondAttempt = client.clock.fire(client.S.reconnectTimer);
  client.sockets[1].emit('open');
  await secondAttempt;
  assert.equal(client.S.reconnectAttempts, 2);
  client.sockets[1].emit('close');
  assert.equal(client.clock.get(client.S.reconnectTimer).delay, 3000);
  await client.onSocketMessage({ data: JSON.stringify({
    type: 'joined', selfId: 'self', resumeToken: 'resume-token',
    room: { id: 'cedar-k4', participants: [{ id: 'self' }] }
  }) });
  assert.equal(client.S.reconnectAttempts, 0);
  assert.equal(client.S.joined, true);
  assert.equal(client.clock.get(client.S.reconnectTimer), undefined);
});

test('reconnect callbacks from an earlier room lifecycle cannot open another socket', () => {
  const client = createClient();
  client.S.joining = true;
  client.tryReconnect();
  const oldTimer = client.S.reconnectTimer;
  client.S.connectionEpoch += 1;
  client.clock.fire(oldTimer);
  assert.equal(client.sockets.length, 0);
  assert.equal(client.S.reconnectAttempts, 0);
});

test('stale socket messages and closes cannot replace the current joined session', async () => {
  const client = createClient();
  const firstConnection = client.connectSocketAt('ws://localhost:8788/quorum-space');
  const oldSocket = client.sockets[0];
  oldSocket.emit('open');
  await firstConnection;
  const secondConnection = client.connectSocketAt('ws://localhost:8788/quorum-space');
  const currentSocket = client.sockets[1];
  currentSocket.emit('open');
  await secondConnection;
  client.S.joined = true;
  client.S.selfId = 'current-self';
  const heartbeat = client.S.heartbeat;
  oldSocket.emit('message', { data: JSON.stringify({ type: 'joined', selfId: 'stale-self' }) });
  oldSocket.emit('close');
  await flushMicrotasks();
  assert.equal(client.S.socket, currentSocket);
  assert.equal(client.S.selfId, 'current-self');
  assert.equal(client.S.joined, true);
  assert.equal(client.S.heartbeat, heartbeat);
  assert.equal(client.S.reconnectTimer, null);
});

test('canceling a pending connection prevents fallback into a different endpoint', async () => {
  const client = createClient({ url: 'http://localhost:5500/quorum/' });
  const pending = client.connectSocket();
  client.S.connectionEpoch += 1;
  client.S.intentionalLeave = true;
  client.S.cancelConnect();
  await assert.rejects(pending, /cancelled/i);
  assert.equal(client.sockets.length, 1);
  assert.equal(client.S.socket, null);
});

test('a heartbeat delayed by background throttling keeps the active room connected', () => {
  const client = createClient();
  setJoinedRoom(client, 'self', 'peer');
  const socket = client.S.socket;
  client.S.lastServerSeen = client.clock.now();
  client.startHeartbeat();
  const heartbeat = client.S.heartbeat;
  client.clock.advance(120000);
  client.clock.fire(heartbeat);
  assert.equal(client.S.socket, socket);
  assert.equal(client.S.joined, true);
  assert.equal(client.S.lastServerSeen, client.clock.now());
  assert.equal(socket.sent[0].type, 'ping');
  client.clock.advance(20000);
  client.clock.fire(heartbeat);
  assert.equal(client.S.socket, socket);
});

test('hidden-page heartbeat ticks do not mistake browser throttling for a dead server', () => {
  const client = createClient();
  setJoinedRoom(client, 'self', 'peer');
  const socket = client.S.socket;
  client.S.lastServerSeen = client.clock.now();
  client.context.document.hidden = true;
  client.startHeartbeat();
  const heartbeat = client.S.heartbeat;
  for (let index = 0; index < 8; index += 1) {
    client.clock.advance(20000);
    client.clock.fire(heartbeat);
  }
  assert.equal(client.S.socket, socket);
  assert.equal(client.S.joined, true);
  assert.equal(socket.sent.length, 8);
});

test('regular unanswered heartbeats recycle a half-open socket and reconnect', () => {
  const client = createClient();
  setJoinedRoom(client, 'self', 'peer');
  const socket = client.S.socket;
  client.S.lastServerSeen = client.clock.now();
  client.startHeartbeat();
  const heartbeat = client.S.heartbeat;
  for (let index = 0; index < 4; index += 1) {
    client.clock.advance(20000);
    client.clock.fire(heartbeat);
  }
  assert.equal(socket.readyState, client.WebSocket.CLOSED);
  assert.equal(client.S.socket, null);
  assert.equal(client.S.heartbeat, null);
  assert.equal(client.S.joined, false);
  assert.equal(client.S.joining, true);
  assert.ok(client.clock.get(client.S.reconnectTimer));
});

test('the initial offerer reserves audio and video senders while permission is pending', () => {
  const client = createClient();
  setJoinedRoom(client, 'a-self', 'peer');
  const peer = client.ensurePeer('peer');
  assert.equal(peer.initialOfferer, true);
  assert.deepEqual(peer.pc.getTransceivers().map((item) => item.receiver.track.kind), ['audio', 'video']);
  assert.equal(peer.pc.getSenders()[1].__qVideo, true);
  assert.ok(peer.pc.getSenders().every((sender) => sender.track === null));
  assert.equal(client.ensurePeer('peer'), peer);
});

test('the initial answerer waits for the offer before creating media sections or negotiating', async () => {
  const client = createClient();
  setJoinedRoom(client, 'z-self', 'peer');
  const peer = client.ensurePeer('peer');
  assert.equal(peer.initialOfferer, false);
  assert.equal(peer.pc.getTransceivers().length, 0);
  await peer.pc.onnegotiationneeded();
  assert.equal(peer.pc.localDescription, null);
  assert.equal(client.S.socket.sent.length, 0);
});

test('stage videos stay muted while dedicated remote audio continues with the camera off', async () => {
  const client = createClient();
  const { media, boxes } = preparePlaybackStage(client);
  const peer = client.ensurePeer('peer');
  const liveAudio = { kind: 'audio', readyState: 'live' };
  const liveVideo = { kind: 'video', readyState: 'live', muted: false };
  peer.remoteStream.addTrack(liveAudio);
  peer.remoteStream.addTrack(liveVideo);
  client.renderStage();
  await flushMicrotasks();
  assert.equal(media.get('self').video.muted, true);
  assert.equal(media.get('self').audio.srcObject, null, 'Local microphone must not play back');
  assert.equal(media.get('peer').video.muted, true);
  assert.equal(media.get('peer').video.srcObject, peer.remoteStream);
  assert.equal(media.get('peer').video.plays, 1, 'Muted video can autoplay independently');
  assert.equal(media.get('peer').audio.muted, false);
  assert.equal(media.get('peer').audio.srcObject, peer.remoteStream);
  assert.equal(media.get('peer').audio.plays, 1);
  assert.equal(client.E.qStageEmpty.hidden, true, 'The waiting message must hide once participants arrive');
  client.S.room.participants[1].camOn = false;
  peer.remoteStream.removeTrack(liveVideo);
  client.renderStage();
  assert.equal(media.get('peer').classes.has('no-cam'), true);
  assert.equal(media.get('peer').audio.muted, false);
  assert.equal(media.get('peer').audio.paused, false, 'Turning a remote camera off must preserve audio playback');
  assert.equal(media.get('peer').audio.srcObject, peer.remoteStream);
  client.S.room.participants = [];
  client.renderStage();
  assert.equal(client.E.qStageEmpty.hidden, false);
  assert.equal(boxes.size, 0);
});

test('blocked audible playback leaves video playing and offers a working Enable audio button', async () => {
  const client = createClient();
  const { media } = preparePlaybackStage(client);
  const peer = client.ensurePeer('peer');
  peer.remoteStream.addTrack({ kind: 'audio', readyState: 'live' });
  peer.remoteStream.addTrack({ kind: 'video', readyState: 'live', muted: false });
  const { audio, video } = media.get('peer');
  let blocked = true;
  audio.play = function () {
    this.plays += 1;
    if (blocked) return Promise.reject(Object.assign(new Error('User gesture required'), { name: 'NotAllowedError' }));
    this.paused = false;
    return Promise.resolve();
  };
  client.attachRemoteStream('peer', peer.remoteStream);
  await flushMicrotasks();
  assert.equal(video.muted, true);
  assert.equal(video.paused, false);
  assert.equal(video.srcObject, peer.remoteStream);
  assert.equal(audio.muted, false);
  assert.equal(audio.paused, true);
  assert.equal(client.S.blockedPlayback.has('peer'), true);
  assert.equal(client.E.qEnableAudioBtn.hidden, false);

  client.bindControls();
  blocked = false;
  client.E.qEnableAudioBtn.dispatch('click');
  assert.equal(audio.plays, 2, 'Retry must call play synchronously within the user click');
  await flushMicrotasks();
  assert.equal(audio.paused, false);
  assert.equal(audio.muted, false);
  assert.equal(client.S.blockedPlayback.size, 0);
  assert.equal(client.E.qEnableAudioBtn.hidden, true);
});

test('removing a participant releases their media and clears a blocked playback prompt', async () => {
  const client = createClient();
  const { media } = preparePlaybackStage(client);
  const peer = client.ensurePeer('peer');
  peer.remoteStream.addTrack({ kind: 'audio', readyState: 'live' });
  client.attachRemoteStream('peer', peer.remoteStream);
  await flushMicrotasks();
  client.S.blockedPlayback.add('peer');
  client.E.qEnableAudioBtn.hidden = false;
  client.closePeer('peer');
  for (const element of [media.get('peer').video, media.get('peer').audio]) {
    assert.equal(element.srcObject, null);
    assert.equal(element.paused, true);
  }
  assert.equal(client.S.blockedPlayback.size, 0);
  assert.equal(client.E.qEnableAudioBtn.hidden, true);
});

test('host participant dragging sends the dragged peer ID with throttled positions and a final group assignment', () => {
  const client = createClient();
  const { box } = prepareHostDrag(client);
  client.bindBoxEvents(box);
  box.dispatch('pointerdown', { clientX: 210, clientY: 120 });
  assert.equal(client.S.drag.id, 'peer');
  assert.equal(box.classes.has('dragging'), true);
  box.dispatch('pointermove', { clientX: 510, clientY: 270 });
  assert.deepEqual(client.S.socket.sent, [{ type: 'host:move', peerId: 'peer', x: 0.5, y: 0.5 }]);
  client.clock.advance(20);
  box.dispatch('pointermove', { clientX: 610, clientY: 320 });
  assert.equal(client.S.socket.sent.length, 1, 'Updates inside the 60 ms throttle window stay local');
  assert.equal(box.style.left, '60%');
  client.clock.advance(40);
  box.dispatch('pointermove', { clientX: 660, clientY: 320 });
  assert.equal(client.S.socket.sent.length, 2);
  box.dispatch('pointerup', { clientX: 660, clientY: 320 });
  assert.deepEqual(client.S.socket.sent[2], {
    type: 'host:move', peerId: 'peer', x: 0.65, y: 0.6, groupId: 'group-a'
  });
  assert.equal(client.S.drag, null);
  assert.equal(box.classes.has('dragging'), false);
});

for (const finishEvent of ['pointercancel', 'lostpointercapture']) {
  test(`participant ${finishEvent} preserves the last position instead of moving to the event origin`, () => {
    const client = createClient();
    const { box } = prepareHostDrag(client);
    client.bindBoxEvents(box);
    box.dispatch('pointerdown', { clientX: 210, clientY: 120 });
    box.dispatch('pointermove', { clientX: 610, clientY: 320 });
    box.dispatch(finishEvent, { clientX: 0, clientY: 0 });
    assert.deepEqual(client.S.socket.sent[1], {
      type: 'host:move', peerId: 'peer', x: 0.6, y: 0.6, groupId: 'group-a'
    });
    assert.equal(client.S.drag, null);
    assert.equal(box.classes.has('dragging'), false);
    box.dispatch('lostpointercapture', { clientX: 0, clientY: 0 });
    assert.equal(client.S.socket.sent.length, 2, 'Capture loss after completion must not send another move');
  });
}

test('a different pointer cannot move or finish an active participant drag', () => {
  const client = createClient();
  const { box } = prepareHostDrag(client);
  client.bindBoxEvents(box);
  box.dispatch('pointerdown', { clientX: 210, clientY: 120 });
  box.dispatch('pointermove', { pointerId: 99, clientX: 900, clientY: 450 });
  box.dispatch('pointerup', { pointerId: 99, clientX: 900, clientY: 450 });
  assert.equal(client.S.socket.sent.length, 0);
  assert.equal(client.S.drag.id, 'peer');
  box.dispatch('pointermove', { clientX: 610, clientY: 320 });
  box.dispatch('pointerup', { clientX: 610, clientY: 320 });
  assert.equal(client.S.drag, null);
  assert.equal(client.S.socket.sent[1].peerId, 'peer');
});

test('canceling a participant click without movement does not broadcast a position', () => {
  const client = createClient();
  const { box } = prepareHostDrag(client);
  client.bindBoxEvents(box);
  box.dispatch('pointerdown', { clientX: 210, clientY: 120 });
  box.dispatch('pointercancel', { clientX: 0, clientY: 0 });
  assert.equal(client.S.drag, null);
  assert.equal(client.S.socket.sent.length, 0);
});

test('host group dragging throttles updates and identifies the moved group', () => {
  const client = createClient();
  const { group, head } = prepareHostDrag(client);
  client.bindGroupEvents(group);
  head.dispatch('pointerdown', { clientX: 610, clientY: 320 });
  group.dispatch('pointermove', { clientX: 660, clientY: 345 });
  assert.deepEqual(client.S.socket.sent[0], { type: 'host:group-update', groupId: 'group-a', x: 0.65, y: 0.65 });
  client.clock.advance(20);
  group.dispatch('pointermove', { clientX: 710, clientY: 370 });
  assert.equal(client.S.socket.sent.length, 1);
  assert.equal(group.style.left, '70%');
  client.clock.advance(40);
  group.dispatch('pointermove', { clientX: 760, clientY: 395 });
  assert.equal(client.S.socket.sent.length, 2);
  group.dispatch('pointerup', { clientX: 760, clientY: 395 });
  assert.deepEqual(client.S.socket.sent[2], { type: 'host:group-update', groupId: 'group-a', x: 0.75, y: 0.75 });
  assert.equal(client.S.drag, null);
  assert.equal(group.classes.has('dragging'), false);
});

for (const finishEvent of ['pointercancel', 'lostpointercapture']) {
  test(`group ${finishEvent} preserves the last moved position`, () => {
    const client = createClient();
    const { group, head } = prepareHostDrag(client);
    client.bindGroupEvents(group);
    head.dispatch('pointerdown', { clientX: 610, clientY: 320 });
    group.dispatch('pointermove', { clientX: 710, clientY: 370 });
    group.dispatch(finishEvent, { clientX: 0, clientY: 0 });
    assert.deepEqual(client.S.socket.sent[1], { type: 'host:group-update', groupId: 'group-a', x: 0.7, y: 0.7 });
    assert.equal(client.S.drag, null);
    assert.equal(group.classes.has('dragging'), false);
    group.dispatch('lostpointercapture', { clientX: 0, clientY: 0 });
    assert.equal(client.S.socket.sent.length, 2);
  });
}

test('a different pointer cannot move or finish an active group drag', () => {
  const client = createClient();
  const { group, head } = prepareHostDrag(client);
  client.bindGroupEvents(group);
  head.dispatch('pointerdown', { clientX: 610, clientY: 320 });
  group.dispatch('pointermove', { pointerId: 99, clientX: 900, clientY: 450 });
  group.dispatch('pointerup', { pointerId: 99, clientX: 900, clientY: 450 });
  assert.equal(client.S.socket.sent.length, 0);
  assert.equal(client.S.drag.id, 'group-a');
  group.dispatch('pointermove', { clientX: 710, clientY: 370 });
  group.dispatch('pointerup', { clientX: 710, clientY: 370 });
  assert.equal(client.S.drag, null);
  assert.equal(client.S.socket.sent[1].groupId, 'group-a');
});

test('incoming media replaces obsolete tracks of the same kind without duplicating active tracks', () => {
  const client = createClient();
  setJoinedRoom(client, 'self', 'peer');
  const peer = client.ensurePeer('peer');
  const oldAudio = { id: 'old-audio', kind: 'audio' };
  const oldVideo = { id: 'old-video', kind: 'video' };
  const newAudio = { id: 'new-audio', kind: 'audio' };
  const newVideo = { id: 'new-video', kind: 'video' };
  peer.pc.ontrack({ track: oldAudio, streams: [] });
  peer.pc.ontrack({ track: oldVideo, streams: [] });
  assert.deepEqual(peer.remoteStream.getTracks(), [oldAudio, oldVideo]);
  peer.pc.ontrack({ track: newVideo, streams: [{ getTracks: () => [oldAudio, newVideo] }] });
  assert.deepEqual(peer.remoteStream.getTracks(), [oldAudio, newVideo]);
  peer.pc.ontrack({ track: newAudio, streams: [] });
  peer.pc.ontrack({ track: newAudio, streams: [] });
  assert.deepEqual(peer.remoteStream.getTracks(), [newVideo, newAudio]);
});

test('fetched relay settings follow the signaling host and refresh existing peers during ICE recovery', async () => {
  const iceServers = [{ urls: 'turns:relay.example:5349', username: 'participant', credential: 'short-lived-token' }];
  let request;
  const client = createClient({ fetch: async (endpoint, options) => {
    request = { endpoint: String(endpoint), options };
    return { ok: true, json: async () => ({ iceServers }) };
  } });
  setJoinedRoom(client, 'self', 'peer');
  client.S.socket.url = 'wss://backend.example/quorum-space?room=cedar-k4';
  const peer = client.ensurePeer('peer');
  const initialConfig = peer.pc.config;
  await client.loadRtcConfig();
  assert.equal(request.endpoint, 'https://backend.example/quorum-config');
  assert.equal(request.options.cache, 'no-store');
  assert.equal(request.options.signal.aborted, false);
  assert.equal(client.S.rtcConfig.iceServers, iceServers);
  assert.equal(peer.pc.config, initialConfig, 'A pending peer can exist before relay credentials arrive');
  client.restartPeerIce(peer);
  assert.equal(peer.pc.config.iceServers, iceServers);
  assert.equal(peer.pc.restarts, 1);
  assert.equal([...client.clock.timers.values()].some((timer) => timer.delay === 4000), false,
    'The relay fetch timeout must be cleared after completion');
  assert.equal(client.clock.get(peer.mediaWaitTimer).delay, 15000,
    'Waiting for media remains monitored independently of the completed configuration fetch');
});

for (const [label, iceServers, expectedMessage] of [
  ['without a relay', [{ urls: 'stun:stun.example:3478' }], /TURN media relay configured by the meeting host/],
  ['with a configured relay', [{ urls: ['stun:stun.example:3478', 'turns:relay.example:5349'] }], /Retry the media connection/]
]) {
  test(`a media connection timeout ${label} displays an actionable diagnostic`, () => {
    const client = createClient();
    setJoinedRoom(client, 'a-self', 'peer');
    client.S.rtcConfig = { iceServers };
    const peer = client.ensurePeer('peer');
    client.syncMediaConnectionUi();
    assert.equal(client.E.qMediaNotice.hidden, true);
    assert.equal(client.clock.get(peer.mediaWaitTimer).delay, 15000);
    client.clock.fire(peer.mediaWaitTimer);
    assert.equal(peer.mediaWaitExpired, true);
    assert.equal(client.E.qMediaNotice.hidden, false);
    assert.match(client.E.qMediaStatus.textContent, expectedMessage);
    if (label === 'with a configured relay') assert.doesNotMatch(client.E.qMediaStatus.textContent, /configured by the meeting host/);
  });
}

test('a recovered media connection clears the diagnostic and stops its connection timeout', () => {
  const client = createClient();
  setJoinedRoom(client, 'a-self', 'peer');
  const peer = client.ensurePeer('peer');
  peer.mediaWaitExpired = true;
  client.syncMediaConnectionUi();
  assert.equal(client.E.qMediaNotice.hidden, false);
  peer.pc.connectionState = 'connected';
  peer.pc.onconnectionstatechange();
  assert.equal(peer.mediaWaitExpired, false);
  assert.equal(client.E.qMediaNotice.hidden, true);
  assert.equal(client.clock.get(peer.mediaWaitTimer), undefined);
});

test('retry refreshes relay credentials and recovers existing peers with renegotiation and an outstanding offer', async () => {
  let fetches = 0;
  const refreshedServers = [{ urls: 'turns:fresh-relay.example:5349', username: 'renewed', credential: 'fresh-token' }];
  const client = createClient({ fetch: async () => {
    fetches += 1;
    return { ok: true, json: async () => ({ iceServers: refreshedServers }) };
  } });
  setJoinedRoom(client, 'a-self', 'peer');
  client.S.room.participants.push({ id: 'second-peer' });
  client.S.rtcConfig = { iceServers: [{ urls: 'turn:old-relay.example:3478', credential: 'expired-token' }] };
  const peer = client.ensurePeer('peer');
  const secondPeer = client.ensurePeer('second-peer');
  peer.pc.connectionState = 'failed';
  secondPeer.pc.localDescription = { type: 'offer', sdp: 'pending-offer-with-tracks' };
  secondPeer.pc.signalingState = 'have-local-offer';

  await client.retryMediaConnections();
  assert.equal(fetches, 1);
  assert.equal(client.S.rtcConfig.iceServers, refreshedServers);
  assert.equal(client.S.peers.get('peer'), peer, 'Recovery must preserve the existing peer and tracks');
  assert.equal(client.S.peers.get('second-peer'), secondPeer);
  assert.equal(peer.pc.restarts, 1);
  assert.equal(peer.pc.config.iceServers, refreshedServers, 'ICE restart must use newly fetched credentials');
  assert.equal(secondPeer.pc.restarts, 0, 'An unacknowledged offer is resent before attempting another negotiation');
  assert.deepEqual(client.S.socket.sent, [
    { type: 'signal', targetId: 'peer', signal: { renegotiate: true } },
    { type: 'signal', targetId: 'second-peer', signal: { renegotiate: true } },
    { type: 'signal', targetId: 'second-peer', signal: { description: secondPeer.pc.localDescription } }
  ]);
});

test('an incoming renegotiation request resends an unacknowledged offer and restarts established media', async () => {
  const client = createClient();
  setJoinedRoom(client, 'a-self', 'peer');
  const peer = client.ensurePeer('peer');
  peer.pc.localDescription = { type: 'offer', sdp: 'still-pending-offer' };
  peer.pc.signalingState = 'have-local-offer';
  await client.handleSignal('peer', { renegotiate: true });
  assert.equal(peer.pc.restarts, 0);
  assert.deepEqual(client.S.socket.sent, [
    { type: 'signal', targetId: 'peer', signal: { description: peer.pc.localDescription } }
  ]);
  peer.pc.remoteDescription = { type: 'answer', sdp: 'accepted-answer' };
  peer.pc.signalingState = 'stable';
  await client.handleSignal('peer', { renegotiate: true });
  assert.equal(peer.pc.restarts, 1);
  assert.equal(client.S.peers.get('peer'), peer);
});

for (const lifecycleChange of ['socket replacement', 'room lifecycle change']) {
  test(`late relay settings cannot overwrite current configuration after ${lifecycleChange}`, async () => {
    let resolveFetch;
    const client = createClient({ fetch: () => new Promise((resolve) => { resolveFetch = resolve; }) });
    setJoinedRoom(client, 'self', 'peer');
    const pending = client.loadRtcConfig();
    const currentConfig = { iceServers: [{ urls: 'turn:current.example:3478' }] };
    client.S.rtcConfig = currentConfig;
    if (lifecycleChange === 'socket replacement') {
      client.S.socket = new client.WebSocket('wss://current.example/quorum-space');
    } else {
      client.S.connectionEpoch += 1;
    }
    resolveFetch({ ok: true, json: async () => ({ iceServers: [{ urls: 'turn:obsolete.example:3478' }] }) });
    await pending;
    assert.equal(client.S.rtcConfig, currentConfig);
    assert.equal(client.clock.timers.size, 0);
  });
}

test('an impolite peer ignores colliding offers and their ICE, then accepts the answer', async () => {
  const client = createClient();
  setJoinedRoom(client, 'a', 'z');
  const peer = client.ensurePeer('z');
  peer.makingOffer = true;
  peer.pc.signalingState = 'have-local-offer';
  peer.queued.push({ candidate: 'obsolete-ice' });
  await client.handleSignal('z', { description: { type: 'offer', sdp: 'colliding-offer' } });
  await client.handleSignal('z', { candidate: { candidate: 'colliding-ice' } });
  assert.equal(peer.ignoreOffer, true);
  assert.equal(peer.queued.length, 0);
  assert.equal(peer.pc.remoteDescription, null);
  assert.equal(peer.pc.candidates.length, 0);
  await client.handleSignal('z', { description: { type: 'answer', sdp: 'accepted-answer' } });
  await client.handleSignal('z', { candidate: { candidate: 'accepted-ice' } });
  assert.equal(peer.ignoreOffer, false);
  assert.equal(peer.pc.remoteDescription.type, 'answer');
  assert.equal(peer.pc.candidates[0].candidate, 'accepted-ice');
  assert.equal(client.S.socket.sent.length, 0);
});

test('a polite peer accepts a colliding offer, flushes queued ICE, and sends an answer', async () => {
  const client = createClient();
  setJoinedRoom(client, 'z', 'a');
  const peer = client.ensurePeer('a');
  peer.makingOffer = true;
  peer.pc.signalingState = 'have-local-offer';
  await client.handleSignal('a', { candidate: { candidate: 'queued-ice' } });
  assert.equal(peer.queued.length, 1);
  await client.handleSignal('a', { description: { type: 'offer', sdp: 'colliding-offer' } });
  assert.equal(peer.ignoreOffer, false);
  assert.equal(peer.queued.length, 0);
  assert.deepEqual(peer.pc.calls, ['remote:offer', 'ice:queued-ice', 'local:answer']);
  assert.equal(client.S.socket.sent[0].type, 'signal');
  assert.equal(client.S.socket.sent[0].signal.description.type, 'answer');
});

test('ICE restarts wait out brief disconnects and stop for removed peers', async () => {
  const client = createClient();
  setJoinedRoom(client, 'self', 'peer');
  const peer = client.ensurePeer('peer');
  peer.pc.connectionState = 'disconnected';
  peer.pc.onconnectionstatechange();
  const briefDisconnectTimer = peer.restartTimer;
  assert.equal(client.clock.get(briefDisconnectTimer).delay, 2000);
  peer.pc.connectionState = 'connected';
  peer.pc.onconnectionstatechange();
  assert.equal(client.clock.get(briefDisconnectTimer), undefined);
  assert.equal(peer.pc.restarts, 0);
  peer.pc.connectionState = 'failed';
  peer.pc.onconnectionstatechange();
  await peer.recovery;
  assert.equal(peer.pc.restarts, 1);
  peer.pc.connectionState = 'disconnected';
  peer.pc.onconnectionstatechange();
  const staleRestart = client.clock.get(peer.restartTimer).fn;
  client.closePeer('peer');
  staleRestart();
  assert.equal(peer.pc.restarts, 1);
  assert.equal(peer.pc.connectionState, 'closed');
  assert.equal(client.S.peers.has('peer'), false);
});

test('refreshing TURN credentials preserves negotiated connection settings', () => {
  const client = createClient();
  setJoinedRoom(client, 'self', 'peer');
  const peer = client.ensurePeer('peer');
  const certificates = [{ fingerprint: 'existing-identity' }];
  const existing = {
    ...peer.pc.config, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 4, iceTransportPolicy: 'relay', certificates
  };
  peer.pc.config = existing;
  peer.pc.localDescription = { type: 'answer', sdp: 'negotiated' };
  peer.pc.setConfiguration = function (config) {
    for (const key of ['bundlePolicy', 'rtcpMuxPolicy', 'iceCandidatePoolSize', 'certificates']) {
      assert.equal(config[key], existing[key], `Changing ${key} must be rejected after negotiation`);
    }
    this.config = config;
  };
  const refreshed = [{ urls: 'turns:relay.example:443?transport=tcp', username: 'user', credential: 'renewed' }];
  client.S.rtcConfig = { iceServers: refreshed, iceCandidatePoolSize: 0 };
  client.restartPeerIce(peer);
  assert.equal(peer.pc.config.iceServers, refreshed);
  assert.equal(peer.pc.config.iceTransportPolicy, 'relay');
  assert.equal(peer.pc.restarts, 1);
  assert.equal(client.logs.length, 0);
});

test('a rejected credential update still attempts ICE recovery with the previous configuration', () => {
  const client = createClient();
  setJoinedRoom(client, 'self', 'peer');
  const peer = client.ensurePeer('peer');
  const original = peer.pc.config;
  client.S.rtcConfig = { iceServers: [{ urls: 'turn:invalid.example' }] };
  peer.pc.setConfiguration = () => { throw new Error('InvalidAccessError'); };
  client.restartPeerIce(peer);
  assert.equal(peer.pc.config, original);
  assert.equal(peer.pc.restarts, 1);
  assert.equal(client.logs.length, 1);
});

for (const exitBeforeResponse of [false, true]) {
  test(`automatic recovery refreshes credentials once and ${exitBeforeResponse ? 'stops after leaving' : 'restarts the peer'}`, async () => {
    let resolveFetch;
    let fetches = 0;
    const refreshed = [{ urls: 'turns:relay.example:443', username: 'user', credential: 'fresh' }];
    const client = createClient({ fetch: () => {
      fetches += 1;
      return new Promise((resolve) => { resolveFetch = resolve; });
    } });
    setJoinedRoom(client, 'self', 'peer');
    const peer = client.ensurePeer('peer');
    peer.pc.connectionState = 'failed';
    peer.pc.onconnectionstatechange();
    const recovery = peer.recovery;
    peer.pc.onconnectionstatechange();
    assert.equal(peer.recovery, recovery);
    assert.equal(fetches, 1);
    assert.equal(peer.pc.restarts, 0);
    if (exitBeforeResponse) {
      client.S.joined = false;
      client.S.connectionEpoch += 1;
      client.closePeer('peer');
    }
    resolveFetch({ ok: true, json: async () => ({ iceServers: refreshed }) });
    await recovery;
    assert.equal(peer.pc.restarts, exitBeforeResponse ? 0 : 1);
    if (!exitBeforeResponse) assert.equal(peer.pc.config.iceServers, refreshed);
    assert.equal(peer.recovery, null);
  });
}

test('retry starts remote audio synchronously before awaiting relay credentials', async () => {
  let resolveFetch;
  const client = createClient({ fetch: () => new Promise((resolve) => { resolveFetch = resolve; }) });
  setJoinedRoom(client, 'self', 'peer');
  const stage = preparePlaybackStage(client);
  const audio = stage.media.get('peer').audio;
  audio.srcObject = { getAudioTracks: () => [{ readyState: 'live' }] };
  const retry = client.retryMediaConnections();
  assert.equal(audio.plays, 1, 'Playback must retain the retry button user gesture');
  resolveFetch({ ok: false });
  await retry;
});

test('an ICE restart negotiates and sends a fresh offer through the active socket', async () => {
  const client = createClient();
  setJoinedRoom(client, 'a-self', 'peer');
  const peer = client.ensurePeer('peer');
  peer.pc.connectionState = 'failed';
  client.restartPeerIce(peer);
  await peer.pc.onnegotiationneeded();
  assert.equal(peer.pc.restarts, 1);
  assert.equal(peer.makingOffer, false);
  assert.equal(client.S.socket.sent[0].targetId, 'peer');
  assert.equal(client.S.socket.sent[0].signal.description.type, 'offer');
});

function observeFocusUI(client, { ending = false } = {}) {
  const calls = { rooms: [], focus: [], summaries: [], completed: [], connections: [], leaves: 0 };
  client.context.window.QuorumFocusUI = {
    updateRoom(room) { calls.rooms.push({ room, joined: client.S.joined }); },
    updateFocus(focus) { calls.focus.push(focus); },
    receiveSummary(summary) { calls.summaries.push(summary); },
    completeLeave(summary) { calls.completed.push(summary); },
    setConnection(connected) { calls.connections.push(connected); },
    isEnding: () => ending,
    requestLeave() { calls.leaves += 1; },
    stop() {},
  };
  return calls;
}

function roomWithFocus(energy = 62) {
  return {
    id: 'cedar-k4', hostId: 'self', participants: [{ id: 'self', name: 'Sam' }],
    focus: { sessionId: 'focus-session', energy, history: [energy], syncsWon: 0, bestChain: 0, drifts: 0 },
  };
}

test('live focus messages update shared room state and UI only while joined', async () => {
  const client = createClient();
  setJoinedRoom(client, 'self', 'peer');
  const calls = observeFocusUI(client);
  const focus = { sessionId: 'focus-session', energy: 89, history: [62, 89], bestChain: 2 };
  await client.onSocketMessage({ data: JSON.stringify({ type: 'focus:state', focus }) });
  assert.equal(client.S.focus.energy, 89);
  assert.equal(client.S.room.focus, client.S.focus);
  assert.equal(calls.focus.length, 1);
  assert.equal(calls.focus[0], client.S.focus);
  assert.equal(client.context.window.QuorumFocusBridge.read().focus, client.S.focus);
  client.S.joined = false;
  await client.onSocketMessage({ data: JSON.stringify({ type: 'focus:state', focus: { ...focus, energy: 8 } }) });
  assert.equal(client.S.focus.energy, 89);
  assert.equal(calls.focus.length, 1);
});

test('room admission and later room snapshots reach focus UI through real state application', async () => {
  const client = createClient({ useRealApplyState: true });
  client.S.roomId = 'cedar-k4';
  client.S.joining = true;
  client.S.pendingFocusSummary = { sessionId: 'previous-session' };
  const calls = observeFocusUI(client);
  await client.onSocketMessage({ data: JSON.stringify({
    type: 'joined', selfId: 'self', resumeToken: 'resume-token', room: roomWithFocus(62),
  }) });
  assert.equal(client.S.joined, true);
  assert.equal(client.S.pendingFocusSummary, null);
  assert.equal(client.S.focus.energy, 62);
  assert.equal(calls.rooms.length, 1);
  assert.equal(calls.rooms[0].joined, true);
  assert.equal(calls.rooms[0].room, client.S.room);
  assert.equal(client.context.window.QuorumFocusBridge.read().isHost, true);
  await client.onSocketMessage({ data: JSON.stringify({ type: 'state', room: roomWithFocus(74), reason: 'reaction' }) });
  assert.equal(client.S.focus.energy, 74);
  assert.equal(calls.rooms.length, 2);
  assert.equal(calls.rooms[1].room.focus, client.S.focus);
});

test('authoritative summary is exposed to the bridge and supplied when a session ends', async () => {
  const client = createClient();
  setJoinedRoom(client, 'self', 'peer');
  const calls = observeFocusUI(client);
  const summary = { sessionId: 'focus-session', score: 84, avgEnergy: 78, contributions: 7, collaborations: 3 };
  await client.onSocketMessage({ data: JSON.stringify({ type: 'session:summary', summary }) });
  assert.equal(client.S.pendingFocusSummary.score, 84);
  assert.equal(calls.summaries.length, 1);
  assert.equal(calls.summaries[0], client.S.pendingFocusSummary);
  assert.equal(client.context.window.QuorumFocusBridge.read().pendingSummary, client.S.pendingFocusSummary);
  await client.onSocketMessage({ data: JSON.stringify({ type: 'session:ended', sessionId: 'focus-session' }) });
  assert.equal(calls.completed.length, 1);
  assert.equal(calls.completed[0], client.S.pendingFocusSummary);
  assert.equal(calls.connections.length, 0);
});

test('session end without a summary lets focus UI use its last known state', async () => {
  const client = createClient();
  setJoinedRoom(client, 'self', 'peer');
  const calls = observeFocusUI(client);
  await client.onSocketMessage({ data: JSON.stringify({ type: 'session:ended' }) });
  assert.equal(calls.completed.length, 1);
  assert.equal(calls.completed[0], undefined);
});

test('session end still cleans up the meeting if the focus UI failed to load', async () => {
  const client = createClient();
  setJoinedRoom(client, 'self', 'peer');
  const socket = client.S.socket;
  await client.onSocketMessage({ data: JSON.stringify({ type: 'session:ended' }) });
  assert.equal(client.S.intentionalLeave, true);
  assert.equal(client.S.joined, false);
  assert.equal(client.S.joining, false);
  assert.equal(client.S.room, null);
  assert.equal(client.S.socket, null);
  assert.equal(socket.readyState, client.WebSocket.CLOSED);
  assert.equal(client.E.qMeet.hidden, true);
  assert.equal(client.E.qJoin.hidden, false);
});

test('a socket close while a session is ending completes the leave without reconnecting', async () => {
  const client = createClient();
  const pending = client.connectSocketAt('ws://localhost:8788/quorum-space');
  const socket = client.sockets[0];
  socket.emit('open');
  await pending;
  client.S.joined = true;
  client.S.roomId = 'cedar-k4';
  client.S.pendingFocusSummary = { sessionId: 'focus-session', score: 80 };
  const calls = observeFocusUI(client, { ending: true });
  socket.emit('close');
  assert.equal(calls.completed.length, 1);
  assert.equal(calls.completed[0], client.S.pendingFocusSummary);
  assert.equal(calls.connections.length, 0);
  assert.equal(client.S.heartbeat, null);
  assert.equal(client.S.reconnectTimer, null);
  assert.equal(client.sockets.length, 1);
  assert.equal(client.clock.timers.size, 0);
});

test('transport loss pauses focus UI and successful room recovery delivers a live snapshot', async () => {
  const client = createClient({ useRealApplyState: true });
  const pending = client.connectSocketAt('ws://localhost:8788/quorum-space');
  const firstSocket = client.sockets[0];
  firstSocket.emit('open');
  await pending;
  client.S.roomId = 'cedar-k4';
  const calls = observeFocusUI(client);
  await client.onSocketMessage({ data: JSON.stringify({
    type: 'joined', selfId: 'self', resumeToken: 'resume-token', room: roomWithFocus(62),
  }) });
  firstSocket.emit('close');
  assert.equal(client.S.joined, false);
  assert.deepEqual(calls.connections, [false]);
  assert.ok(client.clock.get(client.S.reconnectTimer));
  const reconnecting = client.clock.fire(client.S.reconnectTimer);
  const recoveredSocket = client.sockets[1];
  recoveredSocket.emit('open');
  await reconnecting;
  assert.equal(recoveredSocket.sent[0].type, 'join');
  await client.onSocketMessage({ data: JSON.stringify({
    type: 'joined', selfId: 'self', resumeToken: 'resume-token', room: roomWithFocus(58),
  }) });
  assert.equal(client.S.joined, true);
  assert.equal(calls.rooms.length, 2);
  assert.equal(calls.rooms[1].joined, true, 'The UI resumes its live tick from an admitted room snapshot');
  assert.equal(calls.rooms[1].room.focus.energy, 58);
  assert.equal(client.S.focus.energy, 58);
  assert.equal(client.clock.get(client.S.reconnectTimer), undefined);
});

test('meeting leave actions delegate to focus UI and bridge sends existing socket messages', () => {
  const client = createClient();
  setJoinedRoom(client, 'self', 'peer');
  const calls = observeFocusUI(client);
  client.requestLeaveSpace();
  assert.equal(calls.leaves, 1);
  assert.equal(client.S.joined, true, 'The score controller receives a summary before transport cleanup');
  const bridge = client.context.window.QuorumFocusBridge;
  assert.equal(bridge.send({ type: 'focus:channel' }), true);
  assert.equal(client.S.socket.sent[0].type, 'focus:channel');
  client.S.socket.readyState = client.WebSocket.CLOSED;
  assert.equal(bridge.send({ type: 'focus:backchannel' }), false);
});
