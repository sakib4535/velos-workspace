/**
 * Quorum Space — browser client
 * ------------------------------------------------------------------
 * The Quorum platform living inside Velos: a Google-Meet-style call
 * restructured around bound boxes, host-formed groups, a facilitation
 * center, and voting driven by the Velos hand-gesture engine.
 *
 * - Signaling + authoritative state: ws://…/quorum-space (server.js)
 * - Media: WebRTC peer-to-peer mesh (pattern from Velos Room)
 * - Gestures: MediaPipe HandLandmarker + the exact classifier used
 *   by the Velos presenter workspace (recognizeGesture port).
 */

'use strict';

/* ================================================================== */
/* Config                                                              */
/* ================================================================== */

const CFG = Object.freeze({
  wsUrl:
    window.QUORUM_CONFIG?.wsUrl ||
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/quorum-space`,
  rtcConfig: {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
    ]
  },
  gesture: {
    bufferSize: 5,
    confidenceFrames: 3,
    inferenceFps: 24,
    minInferenceFps: 8,
    inputWidth: 480,
    releaseFrames: 2,
    staleFrameMs: 350,
    actionCooldownMs: 900,
    openHoldMs: 1200
  },
  dragThrottleMs: 60,
  heartbeatMs: 20000
});

const MEDIAPIPE_BUNDLE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
const MEDIAPIPE_WASM =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const HAND_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

/* Quorum room-code vocabulary (from the Quorum platform). */
const STEMS = [
  'cedar', 'ember', 'flint', 'grove', 'haven', 'ivory', 'lumen', 'moss',
  'north', 'opal', 'pine', 'quartz', 'ridge', 'sage', 'tide', 'umbra',
  'vale', 'wren', 'ash', 'brine', 'cinder', 'dusk', 'fern', 'glen'
];

const VOTE_META = {
  yes: { emoji: '👍', label: 'Yes' },
  no: { emoji: '👎', label: 'No' },
  abstain: { emoji: '✋', label: 'Abstain' }
};

const GESTURE_LABEL = {
  none: '· none',
  fist: '✊ fist',
  open: '✋ open',
  peace: '✌️ peace',
  thumbsup: '👍 thumbs up',
  thumbsdown: '👎 thumbs down',
  shaka: '🤙 shaka',
};

/* ================================================================== */
/* State                                                               */
/* ================================================================== */

const S = {
  socket: null,
  probeTimer: null,
  probeSocket: null,
  connecting: false,
  joining: false,
  connectionEpoch: 0,
  cancelConnect: null,
  reconnectTimer: null,
  joinTimer: null,
  lastServerSeen: 0,
  preferredWsUrl: '',
  roomWsUrl: '',
  resumeToken: '',
  rtcConfig: null,
  relayStatus: null,
  joined: false,
  intentionalLeave: false,
  heartbeat: null,
  reconnectAttempts: 0,
  roomId: '',
  profile: { position: '', rank: '', skillsets: '', department: '' },
  selfId: '',
  room: null,
  prev: null, /* previous snapshot, for diff toasts */
  focus: null,
  pendingFocusSummary: null,

  localStream: null,
  pendingStream: null,
  mediaReady: null,
  mediaEpoch: 0,
  mediaRequests: { audio: null, video: null },
  cameraTrack: null,
  cameraFacingMode: 'user',
  switchingCamera: false,
  micTrack: null,
  micOn: true,
  camOn: true,
  mediaError: null,
  blockedPlayback: new Set(),

  peers: new Map(), /* peerId -> { id, pc, remoteStream, queued } */

  drag: null, /* { kind:'box'|'group', id, el, moved } */
  speaking: false,
  remoteSpeakers: new Set(),
  presentation: {
    active: false,
    mode: 'slides',
    slideIndex: 0,
    presenterId: null,
    presenterName: '',
    screenStream: null,
    controlSurfaceAllowed: false,
    screenFit: 'fit'
  },
  handDrag: null, /* host drag controlled by a closed fist */
  lastDragSend: 0,

  gesture: {
    wanted: true, /* user toggle */
    active: false, /* loop actually running */
    tracker: null,
    initPromise: null,
    loading: false,
    generation: 0,
    busy: false,
    suspended: false,
    lastInferenceAt: -Infinity,
    lastSampleAt: 0,
    inferenceInterval: 1000 / CFG.gesture.inferenceFps,
    lastVideoTime: -1,
    buffer: [],
    stable: 'none',
    lastActionAt: 0,
    lastDiscrete: null,
    releaseCount: 0,
    openReleaseCount: 0,
    openLatched: false,
    cursorPoint: null,
    feedbackUntil: 0,
    openSince: 0, /* timestamp when open palm first seen */
    rafId: 0
  }
};

/* ================================================================== */
/* Tiny helpers                                                        */
/* ================================================================== */

const $ = (id) => document.getElementById(id);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    timeout
  ]);
}
function storageGet(key) {
  try { return localStorage.getItem(key) || ''; } catch (_) { return ''; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch (_) { /* storage can be unavailable for file URLs */ }
}
const esc = (s) =>
  window.CSS?.escape ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&');
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

const E = {};
[
  'qJoin', 'qMeet', 'qName', 'qRoom', 'qOpenBtn', 'qJoinBtn', 'qJoinStatus',
  'qProfilePosition', 'qProfileRank', 'qProfileSkills', 'qProfileDepartment',
  'qProfileDialog', 'qProfileCloseBtn', 'qProfileTitle', 'qProfileRole',
  'qProfileViewPosition', 'qProfileViewRank', 'qProfileViewSkills',
  'qProfileViewDepartment', 'qProfileViewStage', 'qProfileViewGroup',
  'qRoomChip', 'qInviteBtn', 'qRoomLabel', 'qConnDot', 'qPeopleCount', 'qHostLabel',
  'qLeaveBtn', 'qLeaveBtn2', 'qStage', 'qWorld', 'qCanvasLinks', 'qStageEmpty', 'qStageMeta',
  'qHostHint', 'qNewGroupBtn', 'qFacil', 'qFacilSub', 'qGroupSwatch',
  'qGroupName', 'qGroupNote', 'qMemberRow', 'qMotionText', 'qMotionEdit',
  'qMotionInput', 'qMotionSave', 'qBallotState', 'qCountdown',
  'qMotionActions', 'qVoteSeconds', 'qVoteOpenBtn', 'qResetHandsBtn',
  'qVoteCard', 'qVoteMine', 'qGestureBtn', 'qGestureDot', 'qGestureLive',
  'qGestureChip', 'qGestureAction', 'qTally', 'qHands', 'qMicBtn', 'qCamBtn',
  'qHandBtn', 'qCamVideo', 'qFlipCamBtn', 'qHandCursor', 'qToasts', 'qEnableAudioBtn',
  'qMediaNotice', 'qMediaStatus', 'qRetryMediaBtn',
  'qPresentBtn', 'qToolsBtn', 'qToolsDialog', 'qToolsCloseBtn', 'qToolsShareBtn',
  'qPresentDockBtn', 'qSharedStage', 'qPresentationStatus',
  'qSlidePrevBtn', 'qSlideCounter', 'qSlideNextBtn', 'qShareScreenBtn',
  'qFitScreenBtn', 'qFillScreenBtn', 'qFullscreenBtn',
  'qClosePresentBtn', 'qSlidesWrapper', 'qScreenVideo', 'qRemoteCursor',
  'qRemoteControlStatus', 'qRemoteShareBtn', 'qRemoteShareStopBtn',
  'qRemoteControlRequestBtn', 'qRemoteControlGrantBtn', 'qRemoteControlDenyBtn',
  'qRemoteControlRevokeBtn', 'qRemoteControlCard'
].forEach((id) => { E[id] = $(id); });

let toastTimer = new Map();
function toast(text, mode = '') {
  const el = document.createElement('div');
  el.className = `q-toast ${mode}`.trim();
  el.textContent = text;
  E.qToasts.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, 2600);
}

function mintRoomCode() {
  const stem = STEMS[Math.floor(Math.random() * STEMS.length)];
  const tail = Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(2, 4);
  return `${stem}-${(tail + 'k4').slice(0, 2)}`;
}

function normalizeRoomCode(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

function initialsOf(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  const a = parts[0]?.[0] || '?';
  const b = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (a + b).toUpperCase();
}

function selfParticipant() {
  return S.room?.participants.find((p) => p.id === S.selfId) || null;
}

function isHost() {
  return S.room?.hostId === S.selfId;
}

function fmtCountdown(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/* ================================================================== */
/* Gesture classifier — exact port of the Velos presenter engine       */
/* ================================================================== */

function jointAngleDeg(a, b, c) {
  if (!a || !b || !c) return 0;
  const ab = { x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) };
  const cb = { x: c.x - b.x, y: c.y - b.y, z: (c.z || 0) - (b.z || 0) };
  const ma = Math.hypot(ab.x, ab.y, ab.z);
  const mc = Math.hypot(cb.x, cb.y, cb.z);
  if (ma < 1e-6 || mc < 1e-6) return 0;
  return (Math.acos(clamp((ab.x * cb.x + ab.y * cb.y + ab.z * cb.z) / (ma * mc), -1, 1)) * 180) / Math.PI;
}

function landmarkDistance3D(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
}

function getFingerExtension(landmarks) {
  if (!landmarks || landmarks.length < 21) return [false, false, false, false, false];
  const wrist = landmarks[0];
  const result = [];
  const thumbExtended =
    jointAngleDeg(landmarks[1], landmarks[2], landmarks[3]) > 135 &&
    jointAngleDeg(landmarks[2], landmarks[3], landmarks[4]) > 145 &&
    landmarkDistance3D(landmarks[4], wrist) > landmarkDistance3D(landmarks[3], wrist) * 1.05;
  result.push(thumbExtended);
  for (const [mcp, pip, dip, tip] of [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]]) {
    result.push(
      jointAngleDeg(landmarks[mcp], landmarks[pip], landmarks[dip]) > 150 &&
      jointAngleDeg(landmarks[pip], landmarks[dip], landmarks[tip]) > 145 &&
      landmarkDistance3D(landmarks[tip], wrist) > landmarkDistance3D(landmarks[pip], wrist) * 1.08
    );
  }
  return result;
}

function recognizeGesture(landmarks) {
  if (!landmarks || landmarks.length < 21 || landmarks.some((point) =>
    !point || !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
    (point.z != null && !Number.isFinite(point.z)))) return 'none';
  if (landmarkDistance3D(landmarks[0], landmarks[9]) < 0.005) return 'none';
  const [thumb, index, middle, ring, pinky] = getFingerExtension(landmarks);
  const count = [thumb, index, middle, ring, pinky].filter(Boolean).length;
  if (count === 0) return 'fist';
  if (thumb && pinky && !index && !middle && !ring) return 'shaka';
  if (count >= 4) return 'open';
  if (index && middle && !ring && !pinky) return 'peace';
  if (thumb && !index && !middle && !ring && !pinky) {
    const base = landmarks[2];
    const tip = landmarks[4];
    const dy = tip.y - base.y;
    const threshold = Math.max(0.018, landmarkDistance3D(landmarks[0], landmarks[9]) * 0.32);
    if (Math.abs(dy) > threshold && Math.abs(dy) > Math.abs(tip.x - base.x) * 0.8) {
      return dy < 0 ? 'thumbsup' : 'thumbsdown';
    }
  }
  return 'none';
}

/* ================================================================== */
/* Join screen                                                         */
/* ================================================================== */

function initJoinScreen() {
  const savedName = storageGet('quorum.name');
  if (savedName) E.qName.value = savedName;

  const fromQuery = new URLSearchParams(location.search).get('room');
  const savedRoom = storageGet('quorum.room');
  const initialRoom = normalizeRoomCode(fromQuery || savedRoom);
  if (initialRoom) E.qRoom.value = initialRoom;

  /* Server reachability hint. */
  probeServer();

  E.qOpenBtn.addEventListener('click', () => {
    const name = readName();
    if (!name) return;
    const code = mintRoomCode();
    E.qRoom.value = code;
    joinRoom(code, name, true, readProfile());
  });

  E.qJoinBtn.addEventListener('click', () => {
    const name = readName();
    if (!name) return;
    const code = normalizeRoomCode(E.qRoom.value);
    if (!code) {
      toast('Type a room code, or open a new room', 'bad');
      E.qRoom.focus();
      return;
    }
    joinRoom(code, name, false, readProfile());
  });

  E.qRoom.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') E.qJoinBtn.click();
  });
  E.qName.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') E.qRoom.focus();
  });
}

function readName() {
  const name = String(E.qName.value || '').trim().slice(0, 42);
  if (!name) {
    toast('Add your name before you enter', 'bad');
    E.qName.focus();
    return '';
  }
  storageSet('quorum.name', name);
  return name;
}

function readProfile() {
  return {
    position: String(E.qProfilePosition?.value || '').trim().slice(0, 100),
    rank: String(E.qProfileRank?.value || '').trim().slice(0, 64),
    skillsets: String(E.qProfileSkills?.value || '').trim().slice(0, 180),
    department: String(E.qProfileDepartment?.value || '').trim().slice(0, 100)
  };
}

function stopServerProbe() {
  clearTimeout(S.probeTimer);
  const probe = S.probeSocket;
  S.probeSocket = null;
  try { probe?.close(); } catch (_) { /* already closed */ }
}

function probeServer() {
  stopServerProbe();
  if (S.joined || S.joining || S.connecting) return;
  if (location.protocol === 'file:' || !location.host) {
    setJoinStatus('Run the Quorum server, then open http://localhost:8788/quorum/', 'bad');
    return;
  }
  const urls = getWebSocketUrls();
  const publicBackend = urls.some((url) => !isLocalWebSocketUrl(url));
  setJoinStatus(publicBackend ? 'Connecting to the Quorum service…' : 'Checking server…', '');
  const tryNext = (index) => {
    if (S.joined || S.joining || index >= urls.length) {
      if (!S.joined && !S.joining) {
        setJoinStatus(serverUnavailableMessage(), 'bad');
        S.probeTimer = setTimeout(probeServer, publicBackend ? 10000 : 4000);
      }
      return;
    }

    let probe;
    try {
      probe = new WebSocket(urls[index]);
      S.probeSocket = probe;
    } catch (_) {
      tryNext(index + 1);
      return;
    }
    let settled = false;
    const failed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (S.probeSocket !== probe) return;
      S.probeSocket = null;
      try { probe.close(); } catch (_) { /* already closed */ }
      tryNext(index + 1);
    };
    const timer = setTimeout(() => {
      try { probe.close(); } catch (_) { /* noop */ }
      failed();
    }, index < urls.length - 1 ? 1600 : publicBackend ? 90000 : 1600);
    probe.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (S.probeSocket !== probe) return;
      S.probeSocket = null;
      S.preferredWsUrl = urls[index];
      try { probe.close(); } catch (_) { /* noop */ }
      if (!S.joined && !S.joining) setJoinStatus('Server online', 'good');
    }, { once: true });
    probe.addEventListener('error', failed, { once: true });
    probe.addEventListener('close', failed, { once: true });
  };
  tryNext(0);
}

function getWebSocketUrls() {
  if (S.roomWsUrl) return [S.roomWsUrl];
  const configuredUrl = window.QUORUM_CONFIG?.wsUrl;
  if (configuredUrl) return [configuredUrl];
  if (location.protocol === 'file:' || !location.host) return ['ws://localhost:8788/quorum-space'];

  const primary = S.preferredWsUrl || CFG.wsUrl;
  const host = location.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (isLoopback && location.protocol === 'http:' && location.port !== '8788') {
    return [...new Set([primary, CFG.wsUrl, `ws://${location.hostname}:8788/quorum-space`])];
  }
  const isPrivate = isLoopback || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host.endsWith('.local') || !host.includes('.');
  const fallback = 'wss://velos-workspace.onrender.com/quorum-space';
  // Render hosts are independent room servers. Never switch between them.
  return [...new Set([primary, CFG.wsUrl, ...(!isPrivate && !host.endsWith('.onrender.com') ? [fallback] : [])])];
}

function isLocalWebSocketUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch (_) {
    return false;
  }
}

function serverUnavailableMessage() {
  if (getWebSocketUrls().every(isLocalWebSocketUrl)) {
    return 'Server unavailable. In the project folder run: npm.cmd install, then npm.cmd start. Open http://localhost:8788/quorum/';
  }
  const endpoints = getWebSocketUrls().map((url) => { try { return new URL(url).host; } catch (_) { return url; } });
  return `Quorum service unavailable at ${endpoints.join(' or ')}. Check that the Node service is deployed and running.`;
}

function setJoinStatus(text, mode) {
  E.qJoinStatus.innerHTML = `<span class="q-dot ${mode === 'good' ? 'live' : mode === 'bad' ? 'bad' : ''}"></span>${escapeHtml(text)}`;
}

/* ================================================================== */
/* WebSocket                                                           */
/* ================================================================== */

async function connectSocket() {
  const urls = getWebSocketUrls();
  const epoch = S.connectionEpoch;
  S.connecting = true;
  try {
    for (let index = 0; index < urls.length; index += 1) {
      if (epoch !== S.connectionEpoch || S.intentionalLeave) throw new Error('Connection cancelled');
      try {
        const ws = await connectSocketAt(urls[index], index < urls.length - 1 ? 1800 : undefined);
        S.preferredWsUrl = urls[index];
        return ws;
      } catch (error) {
        if (index === urls.length - 1 || epoch !== S.connectionEpoch) throw error;
      }
    }
  } finally {
    if (epoch === S.connectionEpoch) S.connecting = false;
  }
}

function connectSocketAt(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (location.protocol === 'file:' || !location.host) {
      reject(new Error('Start the server, then open http://localhost:8788'));
      return;
    }
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (_) {
      reject(new Error('Quorum server is not reachable. Start it with: npm start'));
      return;
    }
    S.socket = ws;
    let opened = false;
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (S.socket === ws) S.socket = null;
      if (S.cancelConnect === cancel) S.cancelConnect = null;
      try { ws.close(); } catch (_) { /* already closed */ }
      reject(new Error(message));
    };
    const cancel = () => fail('Connection cancelled');
    S.cancelConnect = cancel;
    const timer = setTimeout(() => {
      fail('Quorum server is not reachable.');
    }, timeoutMs ?? (isLocalWebSocketUrl(url) ? 4000 : 90000));

    ws.addEventListener('open', () => {
      clearTimeout(timer);
      if (settled || S.socket !== ws) { try { ws.close(); } catch (_) {} return; }
      settled = true;
      opened = true;
      S.cancelConnect = null;
      S.lastServerSeen = Date.now();
      startHeartbeat();
      resolve(ws);
    }, { once: true });
    ws.addEventListener('message', (event) => {
      if (S.socket === ws) {
        S.lastServerSeen = Date.now();
        void onSocketMessage(event).catch((error) => console.error('Quorum message failed', error));
      }
    });
    ws.addEventListener('close', () => {
      if (!opened) { fail('Connection closed before the server was ready'); return; }
      if (S.socket !== ws) return;
      S.socket = null;
      onSocketClose();
    });
    ws.addEventListener('error', () => {
      if (!opened) fail('Connection error');
    }, { once: true });
  });
}

function send(data) {
  if (S.socket?.readyState !== WebSocket.OPEN) return false;
  try {
    S.socket.send(JSON.stringify(data));
    return true;
  } catch (_) {
    return false;
  }
}

function startHeartbeat() {
  stopHeartbeat();
  let lastTick = Date.now();
  S.heartbeat = setInterval(() => {
    const now = Date.now();
    const delayed = now - lastTick > CFG.heartbeatMs * 2;
    lastTick = now;
    if (delayed || document.hidden) S.lastServerSeen = now;
    if (now - S.lastServerSeen > CFG.heartbeatMs * 3) {
      recycleSocket();
      return;
    }
    send({ type: 'ping', at: Date.now() });
  }, CFG.heartbeatMs);
}

function recycleSocket() {
  const socket = S.socket;
  if (!socket) return;
  S.socket = null;
  try { socket.close(); } catch (_) { /* stale transport */ }
  onSocketClose();
}
function stopHeartbeat() {
  if (S.heartbeat) clearInterval(S.heartbeat);
  S.heartbeat = null;
}

async function joinRoom(code, name, minted, profile = readProfile()) {
  if (S.joining || S.connecting || S.joined) return;
  stopServerProbe();
  S.connectionEpoch += 1;
  S.intentionalLeave = false;
  S.joining = true;
  S.roomId = code;
  S.roomWsUrl = '';
  S.rtcConfig = null;
  S.relayStatus = null;
  S.reconnectAttempts = 0;
  try { S.resumeToken = sessionStorage.getItem(`quorum.resume.${code}`) || ''; } catch (_) { S.resumeToken = ''; }
  E.qJoinBtn.disabled = true;
  E.qOpenBtn.disabled = true;
  S.profile = profile;
  setJoinStatus('Connecting to the room…', '');
  try {
    await connectSocket();
  } catch (err) {
    if (S.intentionalLeave) return;
    S.joining = false;
    E.qJoinBtn.disabled = false;
    E.qOpenBtn.disabled = false;
    const message = isLocalWebSocketUrl(CFG.wsUrl)
      ? (err?.message || 'Server offline — start with: npm start')
      : serverUnavailableMessage();
    setJoinStatus(message, 'bad');
    S.probeTimer = setTimeout(probeServer, isLocalWebSocketUrl(CFG.wsUrl) ? 4000 : 10000);
    toast(message, 'bad');
    return;
  }

  storageSet('quorum.room', code);
  sendJoin(name, minted);
}

function sendJoin(name = storageGet('quorum.name') || 'Guest', minted = false) {
  send({ type: 'join', roomId: S.roomId, name, minted, profile: S.profile, resumeToken: S.resumeToken });
  clearTimeout(S.joinTimer);
  S.joinTimer = setTimeout(() => {
    if (!S.joined) recycleSocket();
  }, 12000);
}

function onSocketClose() {
  stopHeartbeat();
  clearTimeout(S.joinTimer);
  finishHostHandDrag();
  if (S.intentionalLeave) return;
  if (window.QuorumFocusUI?.isEnding()) {
    window.QuorumFocusUI.completeLeave(S.pendingFocusSummary || undefined);
    return;
  }
  if (S.joined || S.joining) {
    toast('Connection lost — reconnecting…', 'bad');
    S.joined = false;
    window.QuorumFocusUI?.setConnection(false);
    S.joining = true;
    S.drag = null;
    if (S.room) renderTopbar();
    tryReconnect();
  } else {
    setJoinStatus(serverUnavailableMessage(), 'bad');
    E.qJoinBtn.disabled = false;
    E.qOpenBtn.disabled = false;
  }
}

function tryReconnect(immediate = false) {
  if (S.intentionalLeave || S.joined || S.connecting) return;
  clearTimeout(S.reconnectTimer);
  const epoch = S.connectionEpoch;
  const delay = immediate ? 0 : Math.min(15000, 750 * 2 ** Math.min(S.reconnectAttempts, 5)) + Math.random() * 250;
  S.reconnectTimer = setTimeout(async () => {
    if (epoch !== S.connectionEpoch || S.intentionalLeave || S.joined) return;
    if (navigator.onLine === false) { tryReconnect(); return; }
    S.reconnectAttempts += 1;
    setJoinStatus('Reconnecting to your room…', '');
    try {
      await connectSocket();
      if (epoch === S.connectionEpoch && !S.intentionalLeave) sendJoin();
    } catch (_) {
      if (epoch === S.connectionEpoch) tryReconnect();
    }
  }, delay);
}

async function onSocketMessage(ev) {
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch (_) {
    return;
  }

  switch (msg.type) {
    case 'joined': {
      clearTimeout(S.joinTimer);
      clearTimeout(S.reconnectTimer);
      if (S.selfId && S.selfId !== msg.selfId) closeAllPeers();
      S.selfId = msg.selfId;
      S.roomWsUrl = S.socket?.url || S.preferredWsUrl;
      S.resumeToken = msg.resumeToken || '';
      try { sessionStorage.setItem(`quorum.resume.${S.roomId}`, S.resumeToken); } catch (_) { /* storage unavailable */ }
      S.joined = true;
      S.joining = false;
      S.reconnectAttempts = 0;
      S.prev = null;
      S.pendingFocusSummary = null;
      applyState(msg.room, 'joined');
      enterSpace();
      const socket = S.socket;
      if (S.mediaReady) await S.mediaReady;
      if (S.socket !== socket || !S.joined) return;
      for (const participant of S.room?.participants || []) {
        if (participant.id !== S.selfId && participant.connected !== false) {
          const existing = S.peers.get(participant.id);
          if (existing && (['new', 'connecting'].includes(existing.pc.connectionState) || existing.pc.signalingState !== 'stable')) closePeer(participant.id);
          const peer = ensurePeer(participant.id);
          if (['failed', 'disconnected'].includes(peer.pc.connectionState)) restartPeerIce(peer);
        }
      }
      return;
    }
    case 'peer-rejoined':
    case 'peer-joined': {
      applyState(msg.room, 'peer-joined');
      /* We are already in the room: we reach out with the offer. */
      if (msg.participant?.id && S.joined) {
        const socket = S.socket;
        const roomId = msg.room?.id || S.roomId;
        if (S.mediaReady) await S.mediaReady;
        if (!S.joined || S.socket !== socket || S.room?.id !== roomId) return;
        const existing = S.peers.get(msg.participant.id);
        if (existing && msg.type === 'peer-rejoined' && (['new', 'connecting'].includes(existing.pc.connectionState) || existing.pc.signalingState !== 'stable')) closePeer(msg.participant.id);
        const peer = ensurePeer(msg.participant.id);
        if (['failed', 'disconnected'].includes(peer.pc.connectionState)) restartPeerIce(peer);
      }
      return;
    }
    case 'peer-left': {
      closePeer(msg.peerId);
      applyState(msg.room, 'peer-left');
      return;
    }
    case 'state': {
      applyState(msg.room, msg.reason || '');
      return;
    }
    case 'focus:state': {
      if (!S.joined) return;
      S.focus = msg.focus;
      if (S.room) S.room.focus = msg.focus;
      window.QuorumFocusUI?.updateFocus(msg.focus);
      return;
    }
    case 'session:summary': {
      S.pendingFocusSummary = msg.summary;
      window.QuorumFocusUI?.receiveSummary(msg.summary);
      return;
    }
    case 'session:ended': {
      if (window.QuorumFocusUI) window.QuorumFocusUI.completeLeave(S.pendingFocusSummary || undefined);
      else leaveSpace({ silent: true });
      return;
    }
    case 'signal': {
      const socket = S.socket;
      const roomId = S.room?.id;
      if (S.mediaReady) await S.mediaReady;
      if (!S.joined || S.socket !== socket || S.room?.id !== roomId) return;
      await handleSignal(msg.fromId, msg.signal);
      return;
    }
    case 'speaker:active': {
      if (msg.fromId) {
        if (msg.speaking) S.remoteSpeakers.add(msg.fromId);
        else S.remoteSpeakers.delete(msg.fromId);
        updateSpeakingUI();
      }
      return;
    }
    case 'presentation:state': {
      handleRemotePresentationState(msg);
      return;
    }
    case 'room-full': {
      leaveSpace({ silent: true });
      setJoinStatus(`Room full (${msg.maxParticipants})`, 'bad');
      toast(`Room full (${msg.maxParticipants})`, 'bad');
      return;
    }
    case 'error': {
      if (msg.code === 'WORKSPACE_CONFLICT') {
        if (msg.room) applyState(msg.room, 'workspace-conflict');
        window.QuorumWorkspaceUI?.handleConflict(msg.tool);
      } else if (msg.code?.startsWith('WORKSPACE_')) window.QuorumWorkspaceUI?.handleError(msg);
      else if (msg.code?.startsWith('DECISION_')) window.QuorumDecisionUI?.handleError(msg);
      toast(msg.message || 'Room error', 'bad');
      return;
    }
    default:
      return;
  }
}

/* ================================================================== */
/* Media + WebRTC mesh (Velos Room pattern)                            */
/* ================================================================== */

async function acquireMedia() {
  const out = S.localStream || new MediaStream();
  // Publish the stream before permissions resolve so either device can start
  // sending immediately, even while the other permission prompt remains open.
  S.localStream = out;
  S.pendingStream = out;
  await Promise.all([requestLocalMedia('video'), requestLocalMedia('audio')]);
  if (S.pendingStream === out) S.pendingStream = null;
  return S.localStream === out ? out : null;
}

function mediaAccessMessage(kind, error) {
  const label = kind === 'video' ? 'Camera' : 'Microphone';
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    return `${label} permission blocked. Allow it in your browser's site settings, then click ${label} to retry.`;
  }
  return `${label} unavailable. Check the device and permission, then click ${label} to retry.`;
}

function pendingMediaRequest(kind) {
  const request = S.mediaRequests[kind];
  return request?.epoch === S.mediaEpoch && request.stream === S.localStream ? request : null;
}

function requestLocalMedia(kind) {
  const trackKey = kind === 'video' ? 'cameraTrack' : 'micTrack';
  const enabledKey = kind === 'video' ? 'camOn' : 'micOn';
  if (S[trackKey]?.readyState === 'live') return Promise.resolve(S[trackKey]);
  const pending = pendingMediaRequest(kind);
  if (pending) return pending.promise;
  const out = S.localStream || new MediaStream();
  S.localStream = out;
  const mediaEpoch = S.mediaEpoch;
  const roomAtStart = S.roomId;
  const stillInRoom = () => !S.intentionalLeave && S.mediaEpoch === mediaEpoch && S.roomId === roomAtStart && S.localStream === out;
  const request = { epoch: mediaEpoch, stream: out, promise: null };
  S.mediaRequests[kind] = request;
  request.promise = (async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Media capture requires a secure browser connection');
      const stream = await navigator.mediaDevices.getUserMedia(kind === 'video' ? {
        video: { facingMode: { ideal: 'user' }, width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 24, max: 30 } },
        audio: false
      } : {
        video: false,
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      const track = stream.getTracks().find((item) => item.kind === kind);
      for (const item of stream.getTracks()) {
        if (!stillInRoom() || item !== track) item.stop();
      }
      if (!stillInRoom()) return null;
      if (!track || track.readyState !== 'live') throw new Error(`No live ${kind} track was returned`);
      const previousTrack = S[trackKey];
      if (previousTrack) out.removeTrack(previousTrack);
      S[trackKey] = track;
      track.enabled = S[enabledKey];
      out.addTrack(track);
      if (kind === 'video') {
        S.mediaError = null;
        S.cameraFacingMode = track.getSettings?.().facingMode || 'user';
        E.qCamVideo.srcObject = out;
        void E.qCamVideo.play().catch(() => { /* autoplay guard */ });
        if (S.camOn) void startGestureEngine();
      }
      track.onended = () => {
        if (!stillInRoom() || S[trackKey] !== track) return;
        S[trackKey] = null;
        S[enabledKey] = false;
        out.removeTrack(track);
        if (kind === 'video') {
          finishHostHandDrag();
          stopGestureEngine();
          E.qCamVideo.srcObject = null;
        }
        for (const peer of S.peers.values()) void syncLocalTracksToPeer(peer).catch((error) => console.error('Quorum media track failed', error));
        renderStage();
        syncDock();
        send({ type: 'presence', micOn: S.micOn, camOn: S.camOn });
      };
      // Attach each device as soon as it is ready. Waiting for both devices
      // leaves peers with empty senders if the other permission prompt stalls.
      await Promise.allSettled([...S.peers.values()].map((peer) => syncLocalTracksToPeer(peer)));
      if (!stillInRoom()) return null;
      renderStage();
      syncDock();
      send({ type: 'presence', micOn: S.micOn, camOn: S.camOn });
      return track;
    } catch (error) {
      if (!stillInRoom()) return null;
      S[enabledKey] = false;
      const message = mediaAccessMessage(kind, error);
      if (kind === 'video') S.mediaError = message;
      syncDock();
      renderStage();
      send({ type: 'presence', micOn: S.micOn, camOn: S.camOn });
      toast(message, 'bad');
      return null;
    } finally {
      if (S.mediaRequests[kind] === request) S.mediaRequests[kind] = null;
    }
  })();
  return request.promise;
}

function currentOutgoingVideoTrack() {
  const displayTrack = S.presentation.screenStream?.getVideoTracks?.()[0];
  if (displayTrack?.readyState === 'live') return displayTrack;
  return S.camOn && S.cameraTrack?.readyState === 'live' ? S.cameraTrack : null;
}

async function replaceVideoTrack(track) {
  let succeeded = true;
  for (const peer of S.peers.values()) {
    const sender = peer.pc.getSenders().find((item) => item.__qVideo || item.track?.kind === 'video');
    if (!sender) {
      succeeded = false;
      continue;
    }
    sender.__qVideo = true;
    try {
      await sender.replaceTrack(track || null);
    } catch (err) {
      succeeded = false;
      console.error('Quorum video track could not be replaced for peer', peer.id, err);
    }
  }
  return succeeded;
}

async function toggleMic() {
  if (S.micTrack?.readyState !== 'live') {
    S.micOn = pendingMediaRequest('audio') ? !S.micOn : true;
    syncDock();
    send({ type: 'presence', micOn: S.micOn });
    return requestLocalMedia('audio');
  }
  S.micOn = !S.micOn;
  S.micTrack.enabled = S.micOn;
  syncDock();
  send({ type: 'presence', micOn: S.micOn });
}

async function toggleCam() {
  if (S.cameraTrack?.readyState !== 'live') {
    S.camOn = pendingMediaRequest('video') ? !S.camOn : true;
    syncDock();
    send({ type: 'presence', camOn: S.camOn });
    return requestLocalMedia('video');
  }
  S.camOn = !S.camOn;
  S.cameraTrack.enabled = S.camOn;
  if (!S.camOn) {
    finishHostHandDrag();
    stopGestureEngine();
  }
  await replaceVideoTrack(currentOutgoingVideoTrack());
  if (S.camOn && S.gesture.wanted) void startGestureEngine();
  syncDock();
  renderStage();
  send({ type: 'presence', camOn: S.camOn });
}

async function switchCamera() {
  if (S.switchingCamera) return;
  if (!S.cameraTrack || !S.localStream || !navigator.mediaDevices?.getUserMedia) {
    toast('No camera is available to switch', 'bad');
    return;
  }

  const oldTrack = S.cameraTrack;
  const localStreamAtStart = S.localStream;
  const oldDeviceId = oldTrack.getSettings?.().deviceId || '';
  const oldFacingMode = oldTrack.getSettings?.().facingMode || S.cameraFacingMode || 'user';
  const nextFacingMode = oldFacingMode === 'environment' ? 'user' : 'environment';
  let nextTrack = null;
  let stoppedOldTrack = false;
  S.switchingCamera = true;
  resetGestureTracking();
  syncDock();

  const requestCamera = async (video) => {
    const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    const track = stream.getVideoTracks()[0];
    for (const extra of stream.getTracks()) {
      if (extra !== track) extra.stop();
    }
    if (!track) throw new Error('No camera was returned');
    return track;
  };

  try {
    try {
      nextTrack = await requestCamera({
        facingMode: { exact: nextFacingMode },
        width: { ideal: 960 }, height: { ideal: 540 },
        frameRate: { ideal: 24, max: 30 }
      });
    } catch (facingError) {
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      const alternate = devices.find((device) => device.kind === 'videoinput' && device.deviceId && device.deviceId !== oldDeviceId);
      if (alternate) {
        try {
          nextTrack = await requestCamera({
            deviceId: { exact: alternate.deviceId },
            width: { ideal: 960 }, height: { ideal: 540 },
            frameRate: { ideal: 24, max: 30 }
          });
        } catch (_) { /* retry after releasing cameras that permit only one active lens */ }
      }
      if (!nextTrack) {
        try { oldTrack.stop(); } catch (_) {}
        stoppedOldTrack = true;
        nextTrack = await requestCamera({
          facingMode: { ideal: nextFacingMode },
          width: { ideal: 960 }, height: { ideal: 540 },
          frameRate: { ideal: 24, max: 30 }
        });
      }
    }

    if (!S.joined || S.localStream !== localStreamAtStart) {
      nextTrack.stop();
      return;
    }
    const nextDeviceId = nextTrack.getSettings?.().deviceId || '';
    const actualFacingMode = nextTrack.getSettings?.().facingMode || '';
    if (oldDeviceId && nextDeviceId === oldDeviceId && (!actualFacingMode || actualFacingMode === oldFacingMode)) {
      nextTrack.stop();
      nextTrack = null;
      throw Object.assign(new Error('No alternate camera found'), { name: 'NotFoundError' });
    }
    nextTrack.enabled = S.camOn;
    S.localStream.removeTrack(oldTrack);
    S.localStream.addTrack(nextTrack);
    S.cameraTrack = nextTrack;
    S.cameraFacingMode = actualFacingMode || nextFacingMode;
    if (oldTrack !== nextTrack && oldTrack.readyState === 'live') oldTrack.stop();
    E.qCamVideo.srcObject = S.localStream;
    await E.qCamVideo.play().catch(() => {});
    const replaced = await replaceVideoTrack(currentOutgoingVideoTrack());
    if (!replaced && S.peers.size) toast('Camera switched, but a participant may need to reconnect to see it', 'bad');
    renderStage();
    syncDock();
    send({ type: 'presence', micOn: S.micOn, camOn: S.camOn });
    toast(S.cameraFacingMode === 'environment' ? 'Rear camera on' : 'Front camera on', 'good');
  } catch (err) {
    if (nextTrack && nextTrack !== S.cameraTrack) {
      try { nextTrack.stop(); } catch (_) {}
    }
    if (stoppedOldTrack && S.joined && S.localStream === localStreamAtStart) {
      try {
        const restored = await requestCamera(oldDeviceId ? {
          deviceId: { exact: oldDeviceId },
          width: { ideal: 960 }, height: { ideal: 540 }
        } : {
          facingMode: { ideal: oldFacingMode },
          width: { ideal: 960 }, height: { ideal: 540 }
        });
        restored.enabled = S.camOn;
        S.localStream.removeTrack(oldTrack);
        S.localStream.addTrack(restored);
        S.cameraTrack = restored;
        S.cameraFacingMode = restored.getSettings?.().facingMode || oldFacingMode;
        E.qCamVideo.srcObject = S.localStream;
        await E.qCamVideo.play().catch(() => {});
        await replaceVideoTrack(currentOutgoingVideoTrack());
      } catch (_) {
        S.cameraTrack = null;
        S.camOn = false;
        S.localStream.removeTrack(oldTrack);
        E.qCamVideo.srcObject = S.localStream;
        await replaceVideoTrack(currentOutgoingVideoTrack());
        send({ type: 'presence', micOn: S.micOn, camOn: false });
      }
    }
    toast(err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError'
      ? 'No alternate front or rear camera was found'
      : 'Could not switch camera. Check camera permission and try again.', 'bad');
  } finally {
    S.switchingCamera = false;
    resetGestureTracking();
    if (S.camOn && S.gesture.wanted) void startGestureEngine();
    renderStage();
    syncDock();
  }
}

async function loadRtcConfig() {
  const epoch = S.connectionEpoch;
  const socket = S.socket;
  if (window.QUORUM_CONFIG?.rtcConfig) {
    S.rtcConfig = { ...CFG.rtcConfig, ...window.QUORUM_CONFIG.rtcConfig };
    return;
  }
  try {
    const endpoint = new URL(S.socket.url);
    endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:';
    endpoint.pathname = '/quorum-config';
    endpoint.search = '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(endpoint, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) return;
      const config = await response.json();
      if (epoch === S.connectionEpoch && S.socket === socket && Array.isArray(config.iceServers) && config.iceServers.length) {
        S.rtcConfig = { ...CFG.rtcConfig, iceServers: config.iceServers };
        S.relayStatus = config.relay || null;
      }
    } finally { clearTimeout(timer); }
  } catch (_) { /* STUN remains available on older signaling servers. */ }
}

function ensurePeer(peerId) {
  if (S.peers.has(peerId)) return S.peers.get(peerId);

  const pc = new RTCPeerConnection(S.rtcConfig || CFG.rtcConfig);
  const peer = {
    id: peerId, pc, remoteStream: new MediaStream(), queued: [],
    makingOffer: false, ignoreOffer: false, settingRemoteAnswer: false,
    polite: S.selfId.localeCompare(peerId) > 0,
    initialOfferer: S.selfId.localeCompare(peerId) < 0,
    signalQueue: Promise.resolve(), trackQueue: Promise.resolve(), restartTimer: null,
    mediaWaitExpired: false, mediaWaitTimer: null
  };
  S.peers.set(peerId, peer);

  // Only the initial caller reserves media sections. On the answering side,
  // setRemoteDescription creates the transceivers associated with the offer.
  // Pre-creating addTransceiver placeholders there leaves unassociated senders.
  if (peer.initialOfferer) {
    for (const kind of ['audio', 'video']) {
      const transceiver = pc.addTransceiver(kind, { direction: 'sendrecv' });
      if (kind === 'video') transceiver.sender.__qVideo = true;
    }
  }

  pc.onnegotiationneeded = async () => {
    if (!S.joined || S.peers.get(peerId) !== peer) return;
    if (!peer.initialOfferer && !pc.remoteDescription) return;
    try {
      peer.makingOffer = true;
      await syncLocalTracksToPeer(peer);
      if (S.peers.get(peerId) !== peer || !S.joined || pc.signalingState !== 'stable') return;
      await pc.setLocalDescription();
      if (S.peers.get(peerId) === peer) signal(peerId, { description: pc.localDescription });
    } catch (error) {
      if (pc.connectionState !== 'closed') console.error('Quorum negotiation failed', error);
    } finally { peer.makingOffer = false; }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate && S.peers.get(peerId) === peer) signal(peerId, { candidate: event.candidate });
  };

  pc.ontrack = (event) => {
    if (S.peers.get(peerId) !== peer) return;
    const incoming = event.streams?.[0]?.getTracks() || [event.track];
    for (const track of incoming) {
      for (const previous of peer.remoteStream.getTracks()) {
        if (previous.kind === track.kind && previous.id !== track.id) peer.remoteStream.removeTrack(previous);
      }
    }
    const source = event.streams?.[0];
    if (source) {
      for (const track of source.getTracks()) {
        if (!peer.remoteStream.getTracks().some((cur) => cur.id === track.id)) {
          peer.remoteStream.addTrack(track);
        }
      }
    } else if (!peer.remoteStream.getTracks().some((cur) => cur.id === event.track.id)) {
      peer.remoteStream.addTrack(event.track);
    }
    attachRemoteStream(peerId, peer.remoteStream);
    event.track.addEventListener?.('unmute', () => {
      if (S.peers.get(peerId) === peer) attachRemoteStream(peerId, peer.remoteStream);
    });
    event.track.addEventListener?.('ended', () => {
      if (S.peers.get(peerId) !== peer) return;
      peer.remoteStream.removeTrack(event.track);
      attachRemoteStream(peerId, peer.remoteStream);
    });
  };

  pc.onconnectionstatechange = () => {
    if (S.peers.get(peerId) !== peer) return;
    clearTimeout(peer.restartTimer);
    if (pc.connectionState === 'connected') {
      clearTimeout(peer.mediaWaitTimer);
      peer.mediaWaitExpired = false;
    }
    syncMediaConnectionUi();
    if (pc.connectionState === 'disconnected') {
      peer.restartTimer = setTimeout(() => restartPeerIce(peer), 2000);
      return;
    }
    if (pc.connectionState === 'failed') restartPeerIce(peer);
  };

  peer.mediaWaitTimer = setTimeout(() => {
    if (S.peers.get(peerId) !== peer || pc.connectionState === 'connected') return;
    peer.mediaWaitExpired = true;
    syncMediaConnectionUi();
  }, 15000);

  return peer;
}

function syncLocalTracksToPeer(peer) {
  const sync = async () => {
    if (S.peers.get(peer.id) !== peer || peer.pc.connectionState === 'closed') return false;
    for (const kind of ['audio', 'video']) {
      const candidates = peer.pc.getTransceivers().filter((item) => !item.stopped && item.receiver.track.kind === kind);
      const transceiver = candidates.find((item) => item.mid != null) || candidates[0];
      // A new answerer must wait for the incoming offer's media sections.
      if (!transceiver) continue;
      const track = kind === 'video' ? currentOutgoingVideoTrack() : S.micTrack?.readyState === 'live' ? S.micTrack : null;
      if (transceiver.direction !== 'sendrecv') transceiver.direction = 'sendrecv';
      if (kind === 'video') transceiver.sender.__qVideo = true;
      if (S.localStream) transceiver.sender.setStreams?.(S.localStream);
      if (transceiver.sender.track !== track) await transceiver.sender.replaceTrack(track);
    }
    return true;
  };
  peer.trackQueue = (peer.trackQueue || Promise.resolve()).then(sync).catch((error) => {
    console.error('Quorum could not attach local media', error);
    return false;
  });
  return peer.trackQueue;
}

function restartPeerIce(peer) {
  if (!S.joined || S.peers.get(peer.id) !== peer || peer.pc.connectionState === 'closed') return;
  // restartIce triggers negotiationneeded, which sends the new offer.
  try {
    if (S.rtcConfig) peer.pc.setConfiguration(S.rtcConfig);
    peer.pc.restartIce();
  } catch (error) { console.error('Quorum media recovery failed', error); }
}

function signal(targetId, signalData) {
  send({ type: 'signal', targetId, signal: signalData });
}

async function handleSignal(fromId, signalData) {
  if (!fromId || !signalData || fromId === S.selfId || !S.room?.participants.some((p) => p.id === fromId)) return;
  const peer = ensurePeer(fromId);
  peer.signalQueue = peer.signalQueue.then(async () => {
    if (S.peers.get(fromId) !== peer) return;
    if (signalData.renegotiate) {
      if (peer.pc.localDescription?.type === 'offer' && peer.pc.signalingState === 'have-local-offer') {
        signal(fromId, { description: peer.pc.localDescription });
      } else if (peer.initialOfferer || peer.pc.remoteDescription) restartPeerIce(peer);
      return;
    }
    if (signalData.description) {
      const description = new RTCSessionDescription(signalData.description);
      const readyForOffer = !peer.makingOffer && (peer.pc.signalingState === 'stable' || peer.settingRemoteAnswer);
      const collision = description.type === 'offer' && !readyForOffer;
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) { peer.queued.length = 0; return; }
      peer.settingRemoteAnswer = description.type === 'answer';
      try { await peer.pc.setRemoteDescription(description); }
      finally { peer.settingRemoteAnswer = false; }
      await syncLocalTracksToPeer(peer);
      for (const candidate of peer.queued.splice(0)) {
        try { await peer.pc.addIceCandidate(candidate); } catch (_) { /* noop */ }
      }
      if (description.type === 'offer') {
        await peer.pc.setLocalDescription();
        signal(fromId, { description: peer.pc.localDescription });
      }
      return;
    }
    if (signalData.candidate) {
      if (peer.ignoreOffer) return;
      const candidate = new RTCIceCandidate(signalData.candidate);
      if (peer.pc.remoteDescription) {
        await peer.pc.addIceCandidate(candidate);
      } else {
        peer.queued.push(candidate);
      }
    }
  }).catch((error) => {
    if (peer.pc.connectionState !== 'closed') console.error('WebRTC error', error);
  });
  await peer.signalQueue;
}

function attachRemoteStream(peerId, stream) {
  const box = [...E.qStage.querySelectorAll('.q-box')].find((item) => item.dataset.id === peerId);
  const video = box?.querySelector('video');
  const audio = box?.querySelector('audio');
  if (video) {
    video.muted = true; // Video can autoplay even when audible playback is blocked.
    if (video.srcObject !== stream) video.srcObject = stream;
    if (video.paused) void video.play().catch(() => { /* resumes on track unmute */ });
  }
  if (audio && stream.getTracks().some((track) => track.kind === 'audio' && track.readyState === 'live')) {
    audio.muted = false;
    if (audio.srcObject !== stream) audio.srcObject = stream;
    if (audio.paused) {
      void audio.play().then(() => {
        if (audio.srcObject !== stream) return;
        S.blockedPlayback.delete(peerId);
        syncAudioPlaybackUi();
      }).catch((error) => {
        if (audio.srcObject !== stream) return;
        if (error.name === 'NotAllowedError') {
          S.blockedPlayback.add(peerId);
          syncAudioPlaybackUi();
        }
      });
    }
  }
  if (box) {
    const participant = S.room?.participants.find((item) => item.id === peerId);
    const hasVideo = stream.getTracks().some((track) => track.kind === 'video' && track.readyState === 'live' && !track.muted);
    box.classList.toggle('no-cam', !participant?.camOn || !hasVideo);
  }
  if (S.presentation.active && S.presentation.mode === 'screen' && S.presentation.presenterId === peerId && E.qScreenVideo.srcObject !== stream) {
    E.qScreenVideo.srcObject = stream;
    E.qScreenVideo.play().catch(() => { /* autoplay guard */ });
  }
}

function syncAudioPlaybackUi() {
  if (E.qEnableAudioBtn) E.qEnableAudioBtn.hidden = S.blockedPlayback.size === 0;
}

function syncMediaConnectionUi() {
  if (!E.qMediaNotice || !E.qMediaStatus) return;
  const stalled = [...S.peers.values()].some((peer) => peer.mediaWaitExpired || peer.pc.connectionState === 'failed');
  E.qMediaNotice.hidden = !stalled;
  if (!stalled) return;
  if (S.relayStatus?.configured && !S.relayStatus.available) {
    E.qMediaStatus.textContent = 'The meeting media relay is unavailable. Retry, or ask the host to check the relay settings.';
    return;
  }
  const hasRelay = (S.rtcConfig || CFG.rtcConfig).iceServers.some((server) =>
    (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) => /^turns?:/i.test(url))
  );
  E.qMediaStatus.textContent = hasRelay
    ? 'Audio/video is having trouble connecting. Retry the media connection.'
    : 'Audio/video could not connect. This network may need a TURN media relay configured by the meeting host.';
}

async function retryMediaConnections() {
  const epoch = S.connectionEpoch;
  await loadRtcConfig();
  if (!S.joined || epoch !== S.connectionEpoch) return;
  enableRemoteAudio();
  for (const peer of S.peers.values()) {
    signal(peer.id, { renegotiate: true });
    if (peer.pc.localDescription?.type === 'offer' && peer.pc.signalingState === 'have-local-offer') {
      signal(peer.id, { description: peer.pc.localDescription });
    } else restartPeerIce(peer);
  }
}

function enableRemoteAudio() {
  // Call play synchronously within the click gesture to satisfy autoplay rules.
  for (const box of E.qStage.querySelectorAll('.q-box')) {
    const audio = box.querySelector('audio');
    if (!audio?.srcObject) continue;
    const stream = audio.srcObject;
    audio.muted = false;
    void audio.play().then(() => {
      if (audio.srcObject !== stream) return;
      S.blockedPlayback.delete(box.dataset.id);
      syncAudioPlaybackUi();
    }).catch(() => {
      if (audio.srcObject !== stream) return;
      S.blockedPlayback.add(box.dataset.id);
      syncAudioPlaybackUi();
    });
  }
}

function closePeer(peerId) {
  const peer = S.peers.get(peerId);
  if (peer) {
    S.peers.delete(peerId);
    S.blockedPlayback.delete(peerId);
    syncAudioPlaybackUi();
    const box = [...E.qStage.querySelectorAll('.q-box')].find((item) => item.dataset.id === peerId);
    for (const element of box?.querySelectorAll('video, audio') || []) {
      element.pause();
      element.srcObject = null;
    }
    clearTimeout(peer.restartTimer);
    clearTimeout(peer.mediaWaitTimer);
    peer.pc.onconnectionstatechange = null;
    peer.pc.onnegotiationneeded = null;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    try { peer.pc.close(); } catch (_) { /* noop */ }
    syncMediaConnectionUi();
  }
}

function closeAllPeers() {
  for (const peerId of [...S.peers.keys()]) closePeer(peerId);
}

/* ================================================================== */
/* Entering / leaving the space                                        */
/* ================================================================== */

function enterSpace() {
  document.body.dataset.mode = 'meet';
  E.qJoin.hidden = true;
  E.qMeet.hidden = false;
  window.QuorumCanvas?.setLive(true);
  if (!S.pendingStream && !S.localStream) void acquireMedia().catch((error) => console.error('Quorum media failed', error));
  if (S.localStream && S.cameraTrack && S.camOn) void startGestureEngine();
  S.mediaReady = loadRtcConfig();
}

function leaveSpace({ silent = false } = {}) {
  window.QuorumFocusUI?.stop();
  window.QuorumWorkspaceUI?.reset();
  window.QuorumDecisionUI?.reset();
  window.QuorumCanvas?.setLive(false);
  S.intentionalLeave = true;
  S.joined = false;
  S.joining = false;
  S.connectionEpoch += 1;
  S.mediaEpoch += 1;
  S.connecting = false;
  clearTimeout(S.reconnectTimer);
  clearTimeout(S.joinTimer);
  S.cancelConnect?.();
  S.cancelConnect = null;
  try { sessionStorage.removeItem(`quorum.resume.${S.roomId}`); } catch (_) { /* unavailable */ }
  S.resumeToken = '';
  S.roomWsUrl = '';
  stopHeartbeat();
  stopGestureEngine({ dispose: true });
  closeAllPeers();
  if (S.presentation.active || S.presentation.screenStream) closePresentation(false);
  S.drag = null;
  S.pendingStream?.getTracks().forEach((track) => {
    try { track.stop(); } catch (_) { /* noop */ }
  });
  S.pendingStream = null;
  S.mediaReady = null;
  for (const track of S.localStream?.getTracks() || []) {
    try { track.stop(); } catch (_) { /* noop */ }
  }
  S.localStream = null;
  S.cameraTrack = null;
  S.micTrack = null;
  S.selfId = '';
  E.qCamVideo.srcObject = null;
  send({ type: 'leave' });
  try { S.socket?.close(); } catch (_) { /* noop */ }
  S.socket = null;

  document.body.dataset.mode = 'join';
  E.qMeet.hidden = true;
  E.qJoin.hidden = false;
  E.qStage.querySelectorAll('.q-box, .q-group').forEach((el) => el.remove());
  S.room = null;
  S.focus = null;
  S.prev = null;
  E.qJoinBtn.disabled = false;
  E.qOpenBtn.disabled = false;
  probeServer();
  if (!silent) toast('You left the space');
}

function requestLeaveSpace() {
  if (window.QuorumFocusUI) window.QuorumFocusUI.requestLeave();
  else leaveSpace();
}

/* ================================================================== */
/* State application + rendering                                       */
/* ================================================================== */

function applyState(room, reason) {
  if (!room) return;
  const previousPresentation = S.room?.presentation;
  S.prev = S.room;
  S.room = room;
  S.focus = room.focus || S.focus;
  S.roomId = room.id || S.roomId;
  for (const peerId of S.peers.keys()) {
    if (!room.participants.some((participant) => participant.id === peerId)) closePeer(peerId);
  }
  const nextPresentation = room.presentation || null;
  if (JSON.stringify(previousPresentation || null) !== JSON.stringify(nextPresentation)) {
    if (nextPresentation?.active) handleRemotePresentationState(nextPresentation);
    else if (S.presentation.active) closePresentation(false);
  }
  renderTopbar();
  renderStage();
  renderFacil();
  renderRemoteControlUi();
  emitDiffToasts(reason);
  window.QuorumFocusUI?.updateRoom(room);
  window.QuorumWorkspaceUI?.updateRoom(room);
  window.QuorumDecisionUI?.updateRoom(room);
}

function renderTopbar() {
  const room = S.room;
  E.qRoomLabel.textContent = room.id;
  const host = room.participants.find((p) => p.id === room.hostId);
  E.qHostLabel.textContent = `Host — ${host ? host.name : '—'}`;
  E.qPeopleCount.textContent = `${room.participants.length} in space`;

  const online = S.joined && S.socket?.readyState === WebSocket.OPEN;
  E.qConnDot.classList.toggle('bad', !online);
  E.qConnDot.classList.toggle('live', online);
  E.qRoomChip.title = online ? 'Connected · copy invite link' : 'Reconnecting to your room…';

  const hostUi = isHost();
  E.qNewGroupBtn.hidden = !hostUi;
  E.qHostHint.hidden = !hostUi;
  document.body.classList.toggle('is-host', hostUi);
}

function groupById(id) {
  return S.room?.groups.find((g) => g.id === id) || null;
}

function renderStage() {
  const room = S.room;
  if (!room) return;
  const stage = window.QuorumCanvas && E.qWorld ? E.qWorld : E.qStage;

  stage.classList.toggle('empty', room.participants.length === 0);
  E.qStageEmpty.hidden = room.participants.length > 0;

  /* ---- groups ---- */
  const seenGroups = new Set();
  for (const group of room.groups) {
    seenGroups.add(group.id);
    let el = stage.querySelector(`.q-group[data-id="${esc(group.id)}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'q-group';
      el.dataset.id = group.id;
      el.innerHTML = `
        <div class="q-group-head">
          <span class="q-group-mark" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2" width="6" height="6" rx="1.5"/><rect x="12" y="12" width="6" height="6" rx="1.5"/><path d="M8 5h7v7M5 8v7h7"/></svg></span>
          <span class="q-group-name"></span>
          <span class="q-group-count"></span>
          <button class="q-group-x" title="Delete group" type="button">✕</button>
        </div>`;
      stage.appendChild(el);
      bindGroupEvents(el);
    }
    if (S.drag?.kind === 'group' && S.drag.id === group.id) {
      el.classList.add('dragging');
    } else {
      el.classList.remove('dragging');
      el.style.left = `${group.x * 100}%`;
      el.style.top = `${group.y * 100}%`;
    }
    el.style.width = `${group.w * 100}%`;
    el.style.height = `${group.h * 100}%`;
    if (el.style.setProperty) el.style.setProperty('--group-color', group.color);
    else el.style.borderColor = group.color;
    const members = room.participants.filter((p) => p.groupId === group.id);
    el.querySelector('.q-group-name').textContent = group.name;
    el.querySelector('.q-group-count').textContent = `${members.length} ${members.length === 1 ? 'member' : 'members'}`;
  }
  stage.querySelectorAll('.q-group').forEach((el) => {
    if (!seenGroups.has(el.dataset.id)) el.remove();
  });

  /* ---- bound boxes ---- */
  const seenBoxes = new Set();
  for (const p of room.participants) {
    seenBoxes.add(p.id);
    let el = stage.querySelector(`.q-box[data-id="${esc(p.id)}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'q-box';
      el.dataset.id = p.id;
      el.innerHTML = `
        <div class="q-box-content">
          <video autoplay playsinline muted></video>
          <audio autoplay aria-hidden="true"></audio>
          <div class="q-avatar"></div>
          <div class="q-raise-badge">✋</div>
          <div class="q-vote-badge"></div>
          <div class="q-box-bar">
            <div class="q-chip">
              <span class="mic">🎙</span>
              <span class="nm"></span>
              <span class="q-speak-waves"><span class="q-wave-bar"></span><span class="q-wave-bar"></span><span class="q-wave-bar"></span></span>
            </div>
            <div class="q-chip role"></div>
          </div>
        </div>
        <button class="q-profile-trigger" type="button" aria-label="View participant profile" title="View participant profile">+</button>`;
      stage.appendChild(el);
      bindBoxEvents(el);
    }

    const dragging = S.drag?.kind === 'box' && S.drag.id === p.id;
    el.querySelector('video').muted = true;
    el.classList.toggle('dragging', !!dragging);
    el.classList.toggle('self', p.id === S.selfId);
    el.classList.toggle('mirror-camera', p.id === S.selfId && S.cameraFacingMode === 'user');
    el.classList.toggle('host-box', p.id === room.hostId);
    el.classList.toggle('no-cam', !p.camOn);
    el.classList.toggle('raised', p.handRaised);
    const isSpeaking = p.id === S.selfId ? S.speaking : S.remoteSpeakers.has(p.id);
    el.classList.toggle('is-speaking', !!isSpeaking);
    el.classList.toggle('speaking', !!isSpeaking);
    el.classList.toggle('presenting', S.presentation.active && p.id === S.presentation.presenterId);
    const hasVote = p.vote && room.ballot.open;
    el.classList.toggle('voted', !!hasVote);
    if (hasVote) {
      el.querySelector('.q-vote-badge').textContent = VOTE_META[p.vote].emoji;
    }

    if (!dragging) {
      el.style.left = `${p.box.x * 100}%`;
      el.style.top = `${p.box.y * 100}%`;
    }

    el.querySelector('.q-avatar').textContent = initialsOf(p.name);
    el.querySelector('.nm').textContent = p.id === S.selfId ? `You · ${p.name}` : p.name;
    const roleChip = el.querySelector('.role');
    roleChip.textContent = p.id === room.hostId ? 'HOST' : p.id === S.selfId ? 'YOU' : '';
    roleChip.classList.toggle('host', p.id === room.hostId);
    el.querySelector('.mic').textContent = p.micOn ? '🎙' : '🔇';
    el.querySelector('.mic').classList.toggle('off', !p.micOn);
    const profileTrigger = el.querySelector('.q-profile-trigger');
    profileTrigger.hidden = !isHost();
    profileTrigger.setAttribute('aria-label', `View ${p.name}'s profile`);

    if (p.id === S.selfId && S.localStream) {
      const video = el.querySelector('video');
      if (video.srcObject !== S.localStream) {
        video.srcObject = S.localStream;
        video.play().catch(() => { /* autoplay guard */ });
      }
    } else if (p.id !== S.selfId) {
      const peer = S.peers.get(p.id);
      if (peer) attachRemoteStream(p.id, peer.remoteStream);
    }
  }
  stage.querySelectorAll('.q-box').forEach((el) => {
    if (!seenBoxes.has(el.dataset.id)) el.remove();
  });

  /* ---- toolbar meta ---- */
  const groupWord = room.groups.length === 1 ? 'group' : 'groups';
  E.qStageMeta.textContent = room.groups.length
    ? `${room.participants.length} ${room.participants.length === 1 ? 'person' : 'people'} · ${room.groups.length} ${groupWord} · Open canvas`
    : `${room.participants.length} ${room.participants.length === 1 ? 'person' : 'people'} · Open canvas`;
  renderGroupConnections();
}

function renderGroupConnections() {
  if (!window.QuorumCanvas || !E.qCanvasLinks || !document.createElementNS) return;
  let layer = E.qCanvasLinks.querySelector('[data-canvas-groups]');
  if (!layer) {
    layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    layer.setAttribute('data-canvas-groups', '');
    E.qCanvasLinks.appendChild(layer);
  }
  layer.replaceChildren();
  for (const participant of S.room?.participants || []) {
    const group = participant.groupId ? groupById(participant.groupId) : null;
    if (!group) continue;
    const x1 = group.x * 1600;
    const y1 = (group.y - group.h / 2) * 1000 + 58;
    const x2 = participant.box.x * 1600;
    const y2 = participant.box.y * 1000 - 92;
    const curve = Math.abs(y2 - y1) * .45;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M${x1} ${y1} C${x1} ${y1 + curve},${x2} ${y2 - curve},${x2} ${y2}`);
    path.setAttribute('class', 'q-group-link');
    path.style.stroke = group.color;
    layer.appendChild(path);
  }
}

function emitDiffToasts(reason) {
  const prev = S.prev;
  const now = S.room;
  if (!prev || !now) return;
  const me = selfParticipant();
  if (!me) return;

  const prevMe = prev.participants.find((p) => p.id === S.selfId);
  if (prevMe && prevMe.groupId !== me.groupId) {
    const group = me.groupId ? groupById(me.groupId) : null;
    if (group) {
      toast(`You were placed in ${group.name}`, 'good');
      E.qFacil.classList.remove('flash');
      void E.qFacil.offsetWidth; /* restart animation */
      E.qFacil.classList.add('flash');
    } else {
      toast('You are back on the floor');
    }
  }

  if (prev.hostId !== now.hostId && now.hostId === S.selfId) {
    toast('You are the host now — drag people by hand', 'good');
  }

  if (!prev.ballot.open && now.ballot.open) {
    toast('Ballot open — vote with 👍 / 👎 or the buttons', 'good');
  }
  if (prev.ballot.open && !now.ballot.open && reason !== 'vote-open') {
    toast('Ballot closed — see the tally');
  }
}

/* ================================================================== */
/* Facilitation center                                                 */
/* ================================================================== */

let countdownTimer = null;

function renderFacil() {
  const room = S.room;
  if (!room) return;
  const me = selfParticipant();
  if (!me) return;
  const hostUi = isHost();
  const myGroup = me.groupId ? groupById(me.groupId) : null;

  /* ---- group card ---- */
  E.qFacilSub.textContent = myGroup ? myGroup.name : 'Floor';
  E.qGroupSwatch.style.background = myGroup ? myGroup.color : 'var(--faint)';
  E.qGroupName.textContent = myGroup ? myGroup.name : 'On the floor';
  E.qGroupNote.textContent = myGroup
    ? 'Your tile belongs to this group. Drag it to move around the canvas.'
    : 'Drag your tile into a group, or explore the open canvas.';
  E.qMemberRow.innerHTML = '';
  if (myGroup) {
    const members = room.participants.filter((p) => p.groupId === myGroup.id);
    for (const m of members) {
      const chip = document.createElement('span');
      chip.className = 'q-member-chip';
      chip.textContent = `${m.id === S.selfId ? 'You' : m.name}${m.handRaised ? ' ✋' : ''}`;
      E.qMemberRow.appendChild(chip);
    }
  }

  /* ---- motion card ---- */
  E.qMotionText.textContent = room.motion || '— no motion set —';
  E.qMotionText.classList.toggle('none', !room.motion);
  E.qMotionEdit.hidden = !hostUi;
  E.qMotionActions.hidden = !hostUi;
  if (hostUi && !E.qMotionInput.value && room.motion) {
    E.qMotionInput.value = room.motion;
  }

  const votesCast = room.tally?.total
    ? room.tally.total.yes + room.tally.total.no + room.tally.total.abstain
    : 0;
  if (room.ballot.open) {
    E.qBallotState.textContent = '● Ballot open';
    E.qBallotState.className = 'q-ballot-state open';
  } else if (votesCast > 0) {
    E.qBallotState.textContent = '● Ballot closed';
    E.qBallotState.className = 'q-ballot-state closed';
  } else {
    E.qBallotState.textContent = '● No ballot yet';
    E.qBallotState.className = 'q-ballot-state';
  }

  renderCountdown();

  /* ---- vote card ---- */
  const canVote = room.ballot.open && !!me.groupId && !hostUi;
  document.querySelectorAll('.q-vote').forEach((btn) => {
    btn.disabled = !canVote;
    btn.classList.toggle('selected', canVote && me.vote === btn.dataset.vote);
  });
  if (hostUi) {
    E.qVoteMine.textContent = 'As host you facilitate — the groups vote.';
  } else if (!me.groupId) {
    E.qVoteMine.textContent = 'You need to be in a group to vote.';
  } else if (!room.ballot.open) {
    E.qVoteMine.textContent = 'Waiting for the host to open a ballot.';
  } else if (me.vote) {
    const meta = VOTE_META[me.vote];
    E.qVoteMine.innerHTML = `Your vote: <strong>${meta.emoji} ${meta.label}</strong>${me.gestureVotes ? ' · cast by gesture' : ''}`;
  } else {
    E.qVoteMine.textContent = 'No vote cast yet.';
  }

  /* ---- tally ---- */
  renderTally(room);

  /* ---- hands ---- */
  const hands = room.participants.filter((p) => p.handRaised).sort((a, b) => (a.raisedAt || 0) - (b.raisedAt || 0));
  E.qHands.innerHTML = hands.length
    ? hands.map((p) => `<span class="who">${escapeHtml(p.id === S.selfId ? 'You' : p.name)}</span>`).join(' · ')
    : '—';
}

function renderCountdown() {
  const room = S.room;
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  if (!room?.ballot.open || !room.ballot.closesAt) {
    E.qCountdown.hidden = true;
    return;
  }
  const tick = () => {
    const left = (S.room?.ballot.closesAt || 0) - Date.now();
    if (left <= 0 || !S.room?.ballot.open) {
      E.qCountdown.hidden = true;
      if (countdownTimer) clearInterval(countdownTimer);
      countdownTimer = null;
      return;
    }
    E.qCountdown.hidden = false;
    E.qCountdown.textContent = fmtCountdown(left);
    E.qCountdown.classList.toggle('ending', left < 15000);
  };
  tick();
  countdownTimer = setInterval(tick, 500);
}

function renderTally(room) {
  const tally = room.tally;
  if (!tally) {
    E.qTally.innerHTML = '<div class="q-tally-empty">No ballot yet.</div>';
    return;
  }
  const totalVotes = tally.total.yes + tally.total.no + tally.total.abstain;
  if (!tally.open && totalVotes === 0 && !room.ballot.openedAt) {
    E.qTally.innerHTML = '<div class="q-tally-empty">No ballot yet.</div>';
    return;
  }

  const bar = (t) => {
    const sum = t.yes + t.no + t.abstain + t.pending || 1;
    const pct = (n) => `${(n / sum) * 100}%`;
    return `
      <div class="q-tally-bar">
        <div class="seg" style="width:${pct(t.yes)};background:#66dfbd"></div>
        <div class="seg" style="width:${pct(t.no)};background:#ff8585"></div>
        <div class="seg" style="width:${pct(t.abstain)};background:#ffc96b"></div>
        <div class="seg" style="width:${pct(t.pending)};background:rgba(255,255,255,.08)"></div>
      </div>`;
  };
  const legend = `
    <div class="q-tally-seg-legend">
      <span>👍 ${'yes'}</span><span>👎 ${'no'}</span><span>✋ abstain</span><span>· pending</span>
    </div>`.replace(/👍 yes/, '👍').replace(/👎 no/, '👎');

  let html = '';
  for (const g of tally.perGroup) {
    html += `
      <div class="q-tally-row">
        <div class="q-tally-row-head">
          <span style="color:${escapeHtml(g.color)}">${escapeHtml(g.name)}</span>
          <span class="cnt">👍${g.yes} · 👎${g.no} · ✋${g.abstain} · ⏳${g.pending}</span>
        </div>
        ${bar(g)}
      </div>`;
  }
  html += `
    <div class="q-tally-row">
      <div class="q-tally-row-head">
        <span>Whole space</span>
        <span class="cnt">👍${tally.total.yes} · 👎${tally.total.no} · ✋${tally.total.abstain} · ⏳${tally.total.pending}</span>
      </div>
      ${bar(tally.total)}
      ${legend}
    </div>`;

  if (!tally.open && totalVotes > 0) {
    let verdict = 'Tied';
    if (tally.total.yes > tally.total.no) verdict = 'Carried — yes has it';
    else if (tally.total.no > tally.total.yes) verdict = 'Declined — no has it';
    else if (tally.total.abstain > 0) verdict = 'Tied — abstentions hold the floor';
    html += `<div class="q-tally-final">${verdict}</div>`;
  }
  if (tally.open && tally.gestureVotes > 0) {
    html += `<div class="q-card-note">🗳 ${tally.gestureVotes} vote${tally.gestureVotes === 1 ? '' : 's'} cast by hand gesture</div>`;
  }
  E.qTally.innerHTML = html;
}

/* ================================================================== */
/* Host interactions: drag & drop, groups                              */
/* ================================================================== */

function stagePointToNormalized(ev) {
  if (window.QuorumCanvas) return window.QuorumCanvas.screenToWorld(ev.clientX, ev.clientY);
  const rect = E.qStage.getBoundingClientRect();
  return {
    x: clamp((ev.clientX - rect.left) / rect.width, 0.02, 0.98),
    y: clamp((ev.clientY - rect.top) / rect.height, 0.02, 0.98)
  };
}

function groupUnderPoint(point, exceptId = null) {
  if (!S.room) return null;
  for (const g of S.room.groups) {
    if (g.id === exceptId) continue;
    if (
      point.x >= g.x - g.w / 2 && point.x <= g.x + g.w / 2 &&
      point.y >= g.y - g.h / 2 && point.y <= g.y + g.h / 2
    ) {
      return g;
    }
  }
  return null;
}

function bindBoxEvents(el) {
  const profileTrigger = el.querySelector('.q-profile-trigger');
  profileTrigger.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  profileTrigger.addEventListener('click', (ev) => {
    ev.stopPropagation();
    showParticipantProfile(el.dataset.id);
  });

  el.addEventListener('pointerdown', (ev) => {
    if ((!isHost() && el.dataset.id !== S.selfId) || ev.button !== 0 || window.QuorumCanvas?.isPanning()) return;
    ev.stopPropagation();
    ev.preventDefault();
    const id = el.dataset.id;
    const point = stagePointToNormalized(ev);
    const participant = S.room?.participants.find((person) => person.id === id);
    const offset = window.QuorumCanvas && participant
      ? { x: participant.box.x - point.x, y: participant.box.y - point.y } : { x: 0, y: 0 };
    S.drag = { kind: 'box', id, el, moved: false, pointerId: ev.pointerId, lastPosition: point, offset };
    el.setPointerCapture(ev.pointerId);
    el.classList.add('dragging');
  });

  el.addEventListener('pointermove', (ev) => {
    if (S.drag?.kind !== 'box' || S.drag.el !== el || S.drag.pointerId !== ev.pointerId) return;
    const raw = stagePointToNormalized(ev);
    const point = { x: raw.x + S.drag.offset.x, y: raw.y + S.drag.offset.y };
    S.drag.lastPosition = point;
    S.drag.moved = true;
    el.style.left = `${point.x * 100}%`;
    el.style.top = `${point.y * 100}%`;
    highlightGroupAt(point);
    const now = performance.now();
    if (now - S.lastDragSend >= CFG.dragThrottleMs) {
      S.lastDragSend = now;
      send({ type: 'host:move', peerId: S.drag.id, x: point.x, y: point.y });
    }
  });

  const finish = (ev) => {
    if (S.drag?.kind !== 'box' || S.drag.el !== el || S.drag.pointerId !== ev.pointerId) return;
    const id = S.drag.id;
    const moved = S.drag.moved;
    const raw = stagePointToNormalized(ev);
    const point = ['pointercancel', 'lostpointercapture'].includes(ev.type) ? S.drag.lastPosition
      : { x: raw.x + S.drag.offset.x, y: raw.y + S.drag.offset.y };
    S.drag = null;
    el.classList.remove('dragging');
    clearGroupHighlight();
    if (!moved) return;

    const current = S.room?.participants.find((p) => p.id === id);
    if (!current) return;
    const over = groupUnderPoint(point);
    const nextGroup = over ? over.id : null;
    send({ type: 'host:move', peerId: id, x: point.x, y: point.y, groupId: nextGroup });
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  el.addEventListener('lostpointercapture', finish);
}

function showParticipantProfile(peerId) {
  if (!isHost() || !E.qProfileDialog) return;
  const participant = S.room?.participants.find((person) => person.id === peerId);
  if (!participant) return;
  const profile = participant.profile || {};
  const group = participant.groupId ? groupById(participant.groupId) : null;
  E.qProfileTitle.textContent = participant.name;
  E.qProfileRole.textContent = participant.id === S.room.hostId ? 'Host' : 'Room member';
  E.qProfileViewPosition.textContent = profile.position || 'Not provided';
  E.qProfileViewRank.textContent = profile.rank || 'Not provided';
  E.qProfileViewSkills.textContent = profile.skillsets || 'Not provided';
  E.qProfileViewDepartment.textContent = profile.department || 'Not provided';
  E.qProfileViewStage.textContent = window.QuorumCanvas
    ? `${Math.round(participant.box.x * 1600)}, ${Math.round(participant.box.y * 1000)} on the canvas`
    : `${Math.round(participant.box.x * 100)}% across · ${Math.round(participant.box.y * 100)}% down`;
  E.qProfileViewGroup.textContent = group?.name || 'On the floor';
  if (!E.qProfileDialog.open) E.qProfileDialog.showModal();
}

function bindGroupEvents(el) {
  const head = el.querySelector('.q-group-head');
  const xBtn = el.querySelector('.q-group-x');

  xBtn.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  xBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (!isHost()) return;
    const group = groupById(el.dataset.id);
    if (!group) return;
    const members = S.room.participants.filter((p) => p.groupId === group.id).length;
    const ok = members === 0 || window.confirm(`Delete ${group.name}? ${members} member${members === 1 ? '' : 's'} return to the floor.`);
    if (ok) send({ type: 'host:group-delete', groupId: group.id });
  });

  head.addEventListener('pointerdown', (ev) => {
    if (!isHost() || ev.button !== 0) return;
    if (window.QuorumCanvas?.isPanning()) return;
    if (ev.target.closest('.q-group-x')) return;
    if (head.querySelector('.q-rename-input')) return; /* renaming in progress */
    ev.preventDefault();
    ev.stopPropagation();
    const point = stagePointToNormalized(ev);
    const group = groupById(el.dataset.id);
    const offset = window.QuorumCanvas && group
      ? { x: group.x - point.x, y: group.y - point.y } : { x: 0, y: 0 };
    S.drag = { kind: 'group', id: el.dataset.id, el, moved: false, pointerId: ev.pointerId, lastPosition: point, offset };
    el.setPointerCapture(ev.pointerId);
    el.classList.add('dragging');
  });

  el.addEventListener('pointermove', (ev) => {
    if (S.drag?.kind !== 'group' || S.drag.el !== el || S.drag.pointerId !== ev.pointerId) return;
    const raw = stagePointToNormalized(ev);
    const point = { x: raw.x + S.drag.offset.x, y: raw.y + S.drag.offset.y };
    S.drag.lastPosition = point;
    S.drag.moved = true;
    el.style.left = `${point.x * 100}%`;
    el.style.top = `${point.y * 100}%`;
    const now = performance.now();
    if (now - S.lastDragSend >= CFG.dragThrottleMs) {
      S.lastDragSend = now;
      send({ type: 'host:group-update', groupId: S.drag.id, x: point.x, y: point.y });
    }
  });

  const finish = (ev) => {
    if (S.drag?.kind !== 'group' || S.drag.el !== el || S.drag.pointerId !== ev.pointerId) return;
    const moved = S.drag.moved;
    const raw = stagePointToNormalized(ev);
    const point = ['pointercancel', 'lostpointercapture'].includes(ev.type) ? S.drag.lastPosition
      : { x: raw.x + S.drag.offset.x, y: raw.y + S.drag.offset.y };
    S.drag = null;
    el.classList.remove('dragging');
    if (!moved) return;
    send({ type: 'host:group-update', groupId: el.dataset.id, x: point.x, y: point.y });
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  el.addEventListener('lostpointercapture', finish);

  /* Rename: host double-clicks the group name. */
  const nameEl = head.querySelector('.q-group-name');
  head.addEventListener('dblclick', (ev) => {
    if (!isHost() || ev.target.closest('.q-group-x')) return;
    const group = groupById(el.dataset.id);
    if (!group) return;
    const input = document.createElement('input');
    input.className = 'q-input q-rename-input';
    input.value = group.name;
    input.maxLength = 32;
    input.style.padding = '3px 8px';
    input.style.fontSize = '11.5px';
    input.style.width = '130px';
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    const commit = () => {
      const value = String(input.value || '').trim().slice(0, 32);
      const span = document.createElement('span');
      span.className = 'q-group-name';
      span.textContent = value || group.name;
      input.replaceWith(span);
      if (value && value !== group.name) {
        send({ type: 'host:group-update', groupId: group.id, name: value });
      }
    };
    input.addEventListener('keydown', (kev) => {
      if (kev.key === 'Enter') commit();
      if (kev.key === 'Escape') {
        const span = document.createElement('span');
        span.className = 'q-group-name';
        span.textContent = group.name;
        input.replaceWith(span);
      }
      kev.stopPropagation();
    });
    input.addEventListener('blur', commit, { once: true });
    input.addEventListener('pointerdown', (pev) => pev.stopPropagation());
  });
}

function highlightGroupAt(point) {
  E.qStage.querySelectorAll('.q-group').forEach((el) => el.classList.remove('hilite'));
  const over = groupUnderPoint(point);
  if (over) {
    E.qStage.querySelector(`.q-group[data-id="${esc(over.id)}"]`)?.classList.add('hilite');
  }
}

function clearGroupHighlight() {
  E.qStage.querySelectorAll('.q-group').forEach((el) => el.classList.remove('hilite'));
}

function finishHostHandDrag() {
  const handDrag = S.handDrag;
  S.handDrag = null;
  E.qHandCursor.hidden = true;
  E.qHandCursor.classList.remove('dragging');
  if (!handDrag) return;

  S.drag = null;
  handDrag.el.classList.remove('dragging');
  clearGroupHighlight();
  if (!handDrag.moved) return;

  const point = handDrag.lastPosition;
  if (handDrag.kind === 'box') {
    const over = groupUnderPoint(point);
    send({
      type: 'host:move',
      peerId: handDrag.id,
      x: point.x,
      y: point.y,
      groupId: over?.id || null
    });
  } else {
    send({ type: 'host:group-update', groupId: handDrag.id, x: point.x, y: point.y });
  }
}

function beginHostHandDrag(clientX, clientY, point) {
  const target = document.elementFromPoint(clientX, clientY);
  const box = target?.closest('.q-box');
  if (box && E.qStage.contains(box)) {
    const participant = S.room?.participants.find((p) => p.id === box.dataset.id);
    if (!participant) return;
    S.handDrag = {
      kind: 'box',
      id: participant.id,
      el: box,
      offsetX: participant.box.x - point.x,
      offsetY: participant.box.y - point.y,
      lastPosition: { x: participant.box.x, y: participant.box.y },
      moved: false
    };
  } else {
    const head = target?.closest('.q-group-head');
    const groupEl = head?.closest('.q-group');
    const group = groupEl && E.qStage.contains(groupEl) ? groupById(groupEl.dataset.id) : null;
    if (!group) return;
    S.handDrag = {
      kind: 'group',
      id: group.id,
      el: groupEl,
      offsetX: group.x - point.x,
      offsetY: group.y - point.y,
      lastPosition: { x: group.x, y: group.y },
      moved: false
    };
  }

  S.drag = { kind: S.handDrag.kind, id: S.handDrag.id, el: S.handDrag.el, moved: false };
  S.handDrag.el.classList.add('dragging');
  E.qHandCursor.classList.add('dragging');
}

function updateHostHandDrag(landmarks, stable, now) {
  if (!isHost() || !landmarks || landmarks.length < 21) {
    finishHostHandDrag();
    return;
  }

  const rect = E.qStage.getBoundingClientRect();
  const palm = landmarks[9];
  const handX = S.cameraFacingMode === 'environment' ? palm.x : 1 - palm.x;
  const handY = palm.y;
  if (!Number.isFinite(handX) || !Number.isFinite(handY) || !rect.width || !rect.height) {
    finishHostHandDrag();
    return;
  }

  const previous = S.gesture.cursorPoint;
  const distance = previous ? Math.hypot(handX - previous.x, handY - previous.y) : 1;
  const smoothing = clamp(distance * 8, 0.38, 0.85);
  const cursorPoint = {
    x: clamp(previous && distance < 0.002 ? previous.x : previous ? previous.x + (handX - previous.x) * smoothing : handX, 0.02, 0.98),
    y: clamp(previous && distance < 0.002 ? previous.y : previous ? previous.y + (handY - previous.y) * smoothing : handY, 0.02, 0.98)
  };
  S.gesture.cursorPoint = cursorPoint;
  E.qHandCursor.hidden = false;
  E.qHandCursor.style.left = `${cursorPoint.x * rect.width}px`;
  E.qHandCursor.style.top = `${cursorPoint.y * rect.height}px`;
  const clientX = rect.left + cursorPoint.x * rect.width;
  const clientY = rect.top + cursorPoint.y * rect.height;
  const point = stagePointToNormalized({ clientX, clientY });

  if (stable !== 'fist') {
    finishHostHandDrag();
    E.qHandCursor.hidden = false;
    return;
  }
  if (S.drag && !S.handDrag) return; /* a pointer drag owns the stage until it releases */
  if (!S.handDrag) beginHostHandDrag(clientX, clientY, point);
  const drag = S.handDrag;
  if (!drag) return;

  const next = {
    x: window.QuorumCanvas ? point.x + drag.offsetX : clamp(point.x + drag.offsetX, 0.02, 0.98),
    y: window.QuorumCanvas ? point.y + drag.offsetY : clamp(point.y + drag.offsetY, 0.02, 0.98)
  };
  if (Math.hypot(next.x - drag.lastPosition.x, next.y - drag.lastPosition.y) > 0.002) {
    drag.moved = true;
    S.drag.moved = true;
  }
  drag.lastPosition = next;
  drag.el.style.left = `${next.x * 100}%`;

  if (drag.kind === 'box') {
    drag.el.style.top = `${next.y * 100}%`;
    highlightGroupAt(next);
  } else {
    drag.el.style.top = `${next.y * 100}%`;
  }

  if (drag.moved && now - S.lastDragSend >= CFG.dragThrottleMs) {
    S.lastDragSend = now;
    if (drag.kind === 'box') {
      send({ type: 'host:move', peerId: drag.id, x: next.x, y: next.y });
    } else {
      send({ type: 'host:group-update', groupId: drag.id, x: next.x, y: next.y });
    }
  }
}

/* ================================================================== */
/* Gesture engine (MediaPipe — Velos presenter port)                   */
/* ================================================================== */

async function startGestureEngine() {
  const g = S.gesture;
  if (!g.wanted || g.active || g.loading || !S.joined || !S.cameraTrack || !S.camOn) return;
  const generation = ++g.generation;
  g.loading = true;
  setGestureHud('loading model…');
  syncDock();
  let initialization = null;

  try {
    if (!g.tracker) {
      if (!g.initPromise) {
        g.initPromise = import('./gesture-tracker.mjs').then(({ createGestureTracker }) => createGestureTracker({
          bundleUrl: MEDIAPIPE_BUNDLE, wasmUrl: MEDIAPIPE_WASM,
          modelUrl: HAND_MODEL_URL, inputWidth: CFG.gesture.inputWidth
        }, (status) => {
          if (g.loading && g.wanted) setGestureHud(status);
        }));
      }
      initialization = g.initPromise;
      const tracker = await initialization;
      if (g.initPromise !== initialization && g.tracker !== tracker) { tracker.close(); return; }
      g.tracker = tracker;
      g.initPromise = null;
    }
    if (generation !== g.generation) return;
    if (!S.joined || !g.wanted || !S.cameraTrack || !S.camOn) {
      g.loading = false;
      syncDock();
      return;
    }
    resetGestureTracking();
    g.active = true;
    g.loading = false;
    setGestureHud('ready');
    syncDock();
    gestureLoop();
  } catch (err) {
    if (g.initPromise === initialization) g.initPromise = null;
    if (generation !== g.generation) return;
    console.warn('Gesture engine unavailable:', err);
    g.initPromise = null;
    g.loading = false;
    g.active = false;
    g.wanted = false;
    setGestureHud('unavailable · check internet, then retry');
    syncDock();
    toast('Hand tracking could not load. Check internet access, then try Gestures again.', 'bad');
  }
}

function stopGestureEngine({ dispose = false } = {}) {
  const g = S.gesture;
  ++g.generation;
  g.active = false;
  g.loading = false;
  if (g.rafId) cancelAnimationFrame(g.rafId);
  g.rafId = 0;
  resetGestureTracking();
  if (dispose) {
    try { g.tracker?.close(); } catch (_) { /* noop */ }
    g.tracker = null;
    g.initPromise = null; /* the pending initializer closes its result when it resolves */
  }
  E.qGestureLive.hidden = true;
}

function resetGestureTracking({ resetVideo = true } = {}) {
  const g = S.gesture;
  finishHostHandDrag();
  g.buffer = [];
  g.stable = 'none';
  g.openSince = 0;
  g.openLatched = false;
  g.openReleaseCount = 0;
  g.lastDiscrete = null;
  g.releaseCount = 0;
  g.cursorPoint = null;
  if (resetVideo) {
    g.lastVideoTime = -1;
    g.lastInferenceAt = -Infinity;
  }
  g.lastSampleAt = 0;
  g.feedbackUntil = 0;
  E.qGestureChip.textContent = GESTURE_LABEL.none;
}

function gestureLoop() {
  const g = S.gesture;
  if (!g.active) return;
  g.rafId = requestAnimationFrame(gestureLoop);

  const video = E.qCamVideo;
  const now = performance.now();
  const paused = document.hidden || !S.joined || !S.camOn || S.switchingCamera || S.cameraTrack?.readyState !== 'live';
  if (paused || video.readyState < 2 || !video.videoWidth) {
    if (!g.suspended) { resetGestureTracking(); g.suspended = true; }
    return;
  }
  if (g.suspended) { resetGestureTracking(); g.suspended = false; }
  if (g.lastSampleAt && now - g.lastSampleAt > CFG.gesture.staleFrameMs) {
    resetGestureTracking({ resetVideo: false }); /* a stalled camera must release a drag and cancel a hold */
  }
  if (!g.tracker || g.busy || now - g.lastInferenceAt < g.inferenceInterval) return;
  if (video.currentTime === g.lastVideoTime) return;
  g.lastVideoTime = video.currentTime;
  g.lastInferenceAt = now;
  const generation = g.generation;
  const track = S.cameraTrack;
  g.busy = true;
  const started = performance.now();
  void g.tracker.detect(video, now).then((landmarks) => {
    if (!g.active || generation !== g.generation || track !== S.cameraTrack || !S.joined || !S.camOn || S.switchingCamera || document.hidden) return;
    const receivedAt = performance.now();
    const cost = receivedAt - started;
    const target = clamp(cost * 1.35, 1000 / CFG.gesture.inferenceFps, 1000 / CFG.gesture.minInferenceFps);
    g.inferenceInterval = g.inferenceInterval * 0.7 + target * 0.3;
    g.lastSampleAt = receivedAt;
    if (cost > CFG.gesture.staleFrameMs) { resetGestureTracking({ resetVideo: false }); return; }
    processGestureSample(landmarks, receivedAt);
  }).catch((error) => {
    if (!g.active || generation !== g.generation) return;
    console.warn('Hand tracking interrupted:', error);
    stopGestureEngine({ dispose: true });
    g.wanted = false;
    setGestureHud('tracking interrupted · tap Gestures to retry');
    syncDock();
  }).finally(() => { g.busy = false; });
}

function processGestureSample(landmarks, now) {
  const g = S.gesture;
  const raw = recognizeGesture(landmarks);

  /* Require evidence for the current pose; an old majority cannot fire after release. */
  if (raw === 'none') g.buffer = [];
  g.buffer.push(raw);
  while (g.buffer.length > CFG.gesture.bufferSize) g.buffer.shift();
  const count = g.buffer.filter((item) => item === raw).length;
  const stable = raw !== 'none' && count >= CFG.gesture.confidenceFrames ? raw : 'none';
  g.stable = stable;

  if (raw !== g.lastDiscrete) {
    if (++g.releaseCount >= CFG.gesture.releaseFrames) g.lastDiscrete = null;
  } else g.releaseCount = 0;
  if (raw !== 'open') {
    if (++g.openReleaseCount >= CFG.gesture.releaseFrames || !landmarks) {
      g.openSince = 0;
      g.openLatched = false;
    }
  } else g.openReleaseCount = 0;
  if (!landmarks) {
    g.openSince = 0;
    g.lastDiscrete = null;
    g.cursorPoint = null;
  }

  const label = GESTURE_LABEL[stable] || stable;
  if (E.qGestureChip.textContent !== label) E.qGestureChip.textContent = label;
  if (now >= g.feedbackUntil) E.qGestureAction.textContent = gestureHintFor(stable);
  const wasDragging = !!S.handDrag;
  updateHostHandDrag(landmarks, raw === 'open' ? 'open' : stable, now);
  if (wasDragging) g.openLatched = true; /* releasing an object must not also raise a hand */

  /* Open-palm hold = raise / lower hand. */
  if (stable === 'open' && !g.openLatched) {
    if (!g.openSince) g.openSince = now;
    if (now - g.openSince >= CFG.gesture.openHoldMs && now - g.lastActionAt >= CFG.gesture.actionCooldownMs) {
      const me = selfParticipant();
      if (me) {
        g.openLatched = true;
        g.lastActionAt = now;
        send({ type: 'hand', raised: !me.handRaised });
        flashGestureAction(me.handRaised ? '✋ hand lowered' : '✋ hand raised');
      }
    }
  }

  /* Discrete voting gestures. */
  if (stable === 'thumbsup' || stable === 'thumbsdown' || stable === 'peace') {
    if (now - g.lastActionAt >= CFG.gesture.actionCooldownMs && stable !== g.lastDiscrete) {
      g.lastActionAt = now;
      if (applyGestureVote(stable)) g.lastDiscrete = stable;
    }
  }
}

function gestureHintFor(stable) {
  const ballotOpen = !!S.room?.ballot.open;
  if (isHost() && stable === 'fist') return 'move hand to drag · open palm to drop';
  if (stable === 'thumbsup') return ballotOpen ? '→ vote yes' : 'ballot not open';
  if (stable === 'thumbsdown') return ballotOpen ? '→ vote no' : 'ballot not open';
  if (stable === 'peace') return '→ withdraw vote';
  if (stable === 'open') return 'hold to raise hand';
  return '';
}

function applyGestureVote(stable) {
  const me = selfParticipant();
  if (!me) return;
  const room = S.room;

  if (stable === 'peace') {
    if (me.vote) {
      send({ type: 'vote', choice: null, source: 'gesture' });
      flashGestureAction('✌️ vote withdrawn');
    }
    return true;
  }

  if (!room?.ballot.open) {
    flashGestureAction('ballot not open');
    return;
  }
  if (!me.groupId) {
    flashGestureAction('join a group to vote');
    return;
  }

  const choice = stable === 'thumbsup' ? 'yes' : 'no';
  if (me.vote === choice) {
    flashGestureAction(`already voted ${VOTE_META[choice].label.toLowerCase()}`);
    return true;
  }
  send({ type: 'vote', choice, source: 'gesture' });
  flashGestureAction(`${VOTE_META[choice].emoji} voted ${VOTE_META[choice].label}`);
  return true;
}

function flashGestureAction(text) {
  E.qGestureAction.textContent = text;
  S.gesture.feedbackUntil = performance.now() + 1000;
}

function setGestureHud(text) {
  E.qGestureLive.hidden = false;
  E.qGestureAction.textContent = text;
}

function toggleGestureEngine() {
  const g = S.gesture;
  if (!g.active && !g.loading) {
    if (!S.cameraTrack || !S.camOn) {
      toast('Turn on your camera to use hand gestures', 'bad');
      return;
    }
    g.wanted = true;
    void startGestureEngine();
  } else {
    g.wanted = false;
    stopGestureEngine();
  }
  syncDock();
}

/* ================================================================== */
/* Dock + controls                                                     */
/* ================================================================== */

function syncDock() {
  E.qMicBtn.setAttribute('aria-pressed', String(!!S.micOn));
  E.qCamBtn.setAttribute('aria-pressed', String(!!S.camOn));
  E.qFlipCamBtn.disabled = !S.cameraTrack || S.switchingCamera;
  E.qFlipCamBtn.setAttribute('aria-busy', String(S.switchingCamera));
  E.qFlipCamBtn.title = S.switchingCamera ? 'Switching camera…' : 'Switch between front and rear camera';
  E.qGestureBtn.setAttribute('aria-pressed', String(S.gesture.active));
  E.qGestureBtn.disabled = false;
  E.qGestureBtn.setAttribute('aria-busy', String(S.gesture.loading));
  E.qGestureBtn.title = S.gesture.loading ? 'Loading hand tracking · click to cancel' : 'Toggle AI Hand Gestures';
  E.qGestureDot.classList.toggle('on', S.gesture.active);
  if (S.gesture.active) {
    E.qGestureLive.hidden = false;
  }
  const me = selfParticipant();
  E.qHandBtn.setAttribute('aria-pressed', String(!!me?.handRaised));
}

function bindControls() {
  E.qEnableAudioBtn?.addEventListener('click', enableRemoteAudio);
  E.qRetryMediaBtn?.addEventListener('click', () => { enableRemoteAudio(); void retryMediaConnections(); });
  E.qMicBtn.addEventListener('click', toggleMic);
  E.qCamBtn.addEventListener('click', () => void toggleCam());
  E.qFlipCamBtn.addEventListener('click', () => void switchCamera());
  E.qGestureBtn.addEventListener('click', toggleGestureEngine);
  E.qHandBtn.addEventListener('click', () => {
    const me = selfParticipant();
    if (me) send({ type: 'hand', raised: !me.handRaised });
  });
  E.qLeaveBtn.addEventListener('click', requestLeaveSpace);
  E.qLeaveBtn2.addEventListener('click', requestLeaveSpace);
  E.qProfileCloseBtn?.addEventListener('click', () => E.qProfileDialog.close());
  E.qProfileDialog?.addEventListener('click', (ev) => {
    if (ev.target === E.qProfileDialog) E.qProfileDialog.close();
  });

  E.qRoomChip.addEventListener('click', () => void copyInviteLink());
  E.qInviteBtn?.addEventListener('click', () => void copyInviteLink());

  E.qNewGroupBtn.addEventListener('click', () => {
    const count = S.room?.groups.length || 0;
    const center = window.QuorumCanvas?.center() || {};
    send({ type: 'host:group-create', name: `Group ${count + 1}`, ...center });
  });

  E.qMotionSave.addEventListener('click', () => {
    const text = String(E.qMotionInput.value || '').trim().slice(0, 240);
    send({ type: 'host:motion', text });
    toast('Motion set', 'good');
  });
  E.qMotionInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') E.qMotionSave.click();
    ev.stopPropagation();
  });

  E.qVoteOpenBtn.addEventListener('click', () => {
    if (S.room?.ballot.open) {
      send({ type: 'host:vote-close' });
    } else {
      const seconds = Number(E.qVoteSeconds.value) || 0;
      send({ type: 'host:vote-open', seconds });
    }
  });

  E.qResetHandsBtn.addEventListener('click', () => {
    send({ type: 'host:reset-hands' });
  });

  document.querySelectorAll('.q-vote').forEach((btn) => {
    btn.addEventListener('click', () => {
      const me = selfParticipant();
      if (!me) return;
      if (me.vote === btn.dataset.vote) {
        send({ type: 'vote', choice: null, source: 'button' });
      } else {
        send({ type: 'vote', choice: btn.dataset.vote, source: 'button' });
      }
    });
  });

  /* Keyboard: M mic, C camera, G gestures, H hand — mirrors Velos habits. */
  window.addEventListener('keydown', (ev) => {
    if (document.body.dataset.mode !== 'meet') return;
    const tag = ev.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (ev.target?.closest?.('[contenteditable],dialog[open]')) return;
    const key = ev.key.toLowerCase();
    if (key === 'm') toggleMic();
    else if (key === 'c') void toggleCam();
    else if (key === 'g') toggleGestureEngine();
    else if (key === 'h') {
      const me = selfParticipant();
      if (me) send({ type: 'hand', raised: !me.handRaised });
    }
  });


  /* Presentation and ShareView controls */
  E.qToolsBtn?.addEventListener('click', () => {
    if (typeof E.qToolsDialog.showModal === 'function') E.qToolsDialog.showModal();
    else E.qToolsDialog.setAttribute('open', '');
  });
  E.qToolsCloseBtn?.addEventListener('click', () => closeToolsDialog());
  E.qToolsShareBtn?.addEventListener('click', () => {
    closeToolsDialog();
    void startScreenShare();
  });
  E.qToolsDialog?.addEventListener('click', (event) => {
    if (event.target === E.qToolsDialog) closeToolsDialog();
  });

  E.qPresentBtn?.addEventListener('click', () => {
    if (S.presentation.active && S.presentation.presenterId === S.selfId) closePresentation();
    else openPresentation('slides');
  });
  E.qPresentDockBtn?.addEventListener('click', () => {
    if (S.presentation.active && S.presentation.presenterId === S.selfId) closePresentation();
    else openPresentation('slides');
  });
  E.qShareScreenBtn?.addEventListener('click', () => void startScreenShare());
  E.qRemoteShareBtn?.addEventListener('click', () => void startScreenShare());
  E.qRemoteShareStopBtn?.addEventListener('click', () => closePresentation());
  E.qClosePresentBtn?.addEventListener('click', () => closePresentation());
  E.qSlidePrevBtn?.addEventListener('click', prevSlide);
  E.qSlideNextBtn?.addEventListener('click', nextSlide);
  E.qFitScreenBtn?.addEventListener('click', () => setScreenFit('fit'));
  E.qFillScreenBtn?.addEventListener('click', () => setScreenFit('fill'));
  E.qFullscreenBtn?.addEventListener('click', () => void toggleSharedStageFullscreen());
  document.addEventListener('fullscreenchange', syncFullscreenButton);
  E.qRemoteControlRequestBtn?.addEventListener('click', () => {
    const control = S.room?.remoteControl;
    if (!control) return;
    send({ type: control.requesterId === S.selfId || control.controllerId === S.selfId ? 'remote-control:cancel' : 'remote-control:request' });
  });
  E.qRemoteControlGrantBtn?.addEventListener('click', () => {
    const peerId = S.room?.remoteControl?.requesterId;
    if (peerId) send({ type: 'remote-control:grant', peerId });
  });
  E.qRemoteControlDenyBtn?.addEventListener('click', () => {
    const peerId = S.room?.remoteControl?.requesterId;
    if (peerId) send({ type: 'remote-control:deny', peerId });
  });
  E.qRemoteControlRevokeBtn?.addEventListener('click', () => send({ type: 'remote-control:revoke' }))

  E.qScreenVideo?.addEventListener('pointerdown', onRemoteScreenPointerDown);
  E.qScreenVideo?.addEventListener('pointermove', onRemoteScreenPointerMove);
  E.qScreenVideo?.addEventListener('pointerup', onRemoteScreenPointerUp);
  E.qScreenVideo?.addEventListener('pointercancel', onRemoteScreenPointerUp);
  E.qScreenVideo?.addEventListener('lostpointercapture', onRemoteScreenPointerUp);
  E.qScreenVideo?.addEventListener('contextmenu', (event) => { if (canControlRemoteScreen()) event.preventDefault(); });
  E.qScreenVideo?.addEventListener('wheel', onRemoteScreenWheel, { passive: false });
  window.addEventListener('keydown', onRemoteScreenKeyDown, true);
  window.addEventListener('keyup', onRemoteScreenKeyUp, true);
  window.addEventListener('blur', releaseRemoteScreenInput);
  window.addEventListener('resize', renderRemoteControlUi);
  window.addEventListener('keydown', (event) => {
    if (!S.presentation.active || S.presentation.presenterId !== S.selfId || document.activeElement === E.qScreenVideo) return;
    if (event.key === 'ArrowRight') { event.preventDefault(); nextSlide(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); prevSlide(); }
  });

  const resumeConnection = () => {
    if (S.intentionalLeave) return;
    if (S.joined && S.socket?.readyState === WebSocket.OPEN) {
      S.lastServerSeen = Date.now();
      send({ type: 'ping', at: Date.now() });
      for (const peer of S.peers.values()) {
        if (['failed', 'disconnected'].includes(peer.pc.connectionState)) restartPeerIce(peer);
      }
      if (S.camOn && S.cameraTrack) void startGestureEngine();
    } else if (S.joining) tryReconnect(true);
    else probeServer();
  };
  window.addEventListener('online', resumeConnection);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) resumeConnection();
  });
  window.addEventListener('beforeunload', () => {
    S.intentionalLeave = true;
    try { S.socket?.close(); } catch (_) { /* noop */ }
  });
}

/* Ballot-open button doubles as "Close ballot" while open. */
const voteOpenLabelSync = () => {
  if (!E.qVoteOpenBtn) return;
  E.qVoteOpenBtn.textContent = S.room?.ballot.open ? 'Close ballot' : 'Open ballot';
};
const origRenderFacil = renderFacil;
renderFacil = function wrappedRenderFacil() {
  origRenderFacil();
  voteOpenLabelSync();
  syncDock();
};


/* ================================================================== */
/* VELOS QUORUM — PRESENTATION AND SHAREVIEW CONTROL                  */
/* ================================================================== */

const PRESENTATION_SLIDES = [
  {
    tag: 'VELOS QUORUM',
    title: 'A room with a shared floor.',
    lead: 'Explore an open canvas together. Drag to pan, zoom into a conversation, and move your own tile anywhere.',
    features: [
      { title: 'Bound boxes', note: 'Everyone has a clear place in the room.' },
      { title: 'Host-led groups', note: 'Move people into focused conversations.' },
      { title: 'Shared floor', note: 'Keep the whole room in view.' }
    ]
  },
  {
    tag: 'HAND GESTURES',
    title: 'Votes can be cast by hand.',
    lead: 'Participants vote yes, no, or abstain with controls or familiar hand gestures.',
    features: [
      { title: '👍 Yes', note: 'Thumbs up records an affirmative vote.' },
      { title: '👎 No', note: 'Thumbs down records a negative vote.' },
      { title: '✋ Raise', note: 'Hold an open hand to raise your hand.' }
    ]
  },
  {
    tag: 'SHARED CONTROL',
    title: 'Work together on the host display.',
    lead: 'The host can share the primary display and approve one participant to control it for the current session.',
    features: [
      { title: 'Visible approval', note: 'Every control request needs host approval.' },
      { title: 'Primary display', note: 'Share the entire primary display for accurate input.' },
      { title: 'Immediate revoke', note: 'The host can end control at any time.' }
    ]
  },
  {
    tag: 'FACILITATION',
    title: 'Make the decision together.',
    lead: 'Set a motion, open a timed ballot, and review the live group tally in one place.',
    features: [
      { title: 'Clear motion', note: 'Keep the question in front of every participant.' },
      { title: 'Timed ballot', note: 'Choose a deadline or leave voting open.' },
      { title: 'Live tally', note: 'See group results as votes arrive.' }
    ]
  }
];

function closeToolsDialog() {
  if (!E.qToolsDialog) return;
  if (typeof E.qToolsDialog.close === 'function' && E.qToolsDialog.open) E.qToolsDialog.close();
  else E.qToolsDialog.removeAttribute('open');
}

function getInviteLink() {
  const url = new URL(location.href);
  url.searchParams.set('room', S.roomId);
  url.hash = '';
  return url.toString();
}

async function copyInviteLink() {
  if (!S.roomId) return;
  const url = getInviteLink();
  if (navigator.share && window.matchMedia?.('(pointer: coarse)').matches) {
    try {
      await navigator.share({ title: 'Join my Velos Quorum room', text: 'Join my Quorum room', url });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied', 'good');
  } catch (_) {
    window.prompt('Copy this Quorum invite link:', url);
  }
}

function setScreenFit(mode) {
  S.presentation.screenFit = mode === 'fill' ? 'fill' : 'fit';
  E.qScreenVideo.classList.toggle('q-screen-fill', S.presentation.screenFit === 'fill');
  E.qFitScreenBtn?.setAttribute('aria-pressed', String(S.presentation.screenFit === 'fit'));
  E.qFillScreenBtn?.setAttribute('aria-pressed', String(S.presentation.screenFit === 'fill'));
}

async function toggleSharedStageFullscreen() {
  if (!S.presentation.active || !E.qSharedStage) return;
  try {
    if (document.fullscreenElement === E.qSharedStage) await document.exitFullscreen();
    else await E.qSharedStage.requestFullscreen();
  } catch (_) {
    toast('Full-screen mode is unavailable in this browser', 'bad');
  }
  syncFullscreenButton();
}

function syncFullscreenButton() {
  const fullscreen = document.fullscreenElement === E.qSharedStage;
  if (!E.qFullscreenBtn) return;
  E.qFullscreenBtn.textContent = fullscreen ? 'Exit full screen' : 'Full screen';
  E.qFullscreenBtn.title = fullscreen ? 'Return to the Quorum page' : 'Expand the shared stage to full screen';
}

function syncPresentationControls() {
  const active = S.presentation.active;
  const owns = active && S.presentation.presenterId === S.selfId;
  const screen = active && S.presentation.mode === 'screen';
  const slides = active && S.presentation.mode === 'slides';
  if (E.qShareScreenBtn) E.qShareScreenBtn.hidden = screen;
  if (E.qFitScreenBtn) E.qFitScreenBtn.hidden = !screen;
  if (E.qFillScreenBtn) E.qFillScreenBtn.hidden = !screen;
  if (E.qFullscreenBtn) E.qFullscreenBtn.hidden = !active;
  if (E.qSlidePrevBtn) E.qSlidePrevBtn.hidden = !slides || !owns;
  if (E.qSlideNextBtn) E.qSlideNextBtn.hidden = !slides || !owns;
  if (E.qClosePresentBtn) E.qClosePresentBtn.hidden = !owns;
}

function openPresentation(mode = 'slides', broadcast = true) {
  const pres = S.presentation;
  if (mode !== 'screen' && pres.screenStream) {
    const oldStream = pres.screenStream;
    pres.screenStream = null;
    for (const track of oldStream.getTracks()) { try { track.stop(); } catch (_) {} }
    void replaceVideoTrack(currentOutgoingVideoTrack());
  }
  pres.active = true;
  pres.mode = mode;
  pres.presenterId = S.selfId;
  pres.presenterName = selfParticipant()?.name || 'Presenter';
  pres.controlSurfaceAllowed = mode === 'screen' && !!pres.controlSurfaceAllowed;
  
  E.qSharedStage.hidden = false;
  E.qPresentBtn?.classList.add('primary');
  E.qPresentDockBtn?.setAttribute('aria-pressed', 'true');
  
  if (mode === 'slides') {
    E.qScreenVideo.hidden = true;
    E.qSlidesWrapper.hidden = false;
    renderSlide(pres.slideIndex, false);
  } else if (mode === 'screen') {
    E.qSlidesWrapper.hidden = true;
    E.qScreenVideo.hidden = false;
  }
  
  E.qPresentationStatus.textContent = mode === 'screen' ? 'Sharing the host display' : 'Presentation slides';
  syncPresentationControls();
  renderStage();
  
  if (broadcast) {
    send({
      type: 'presentation:state',
      active: true,
      mode,
      slideIndex: pres.slideIndex,
      presenterId: pres.presenterId,
      presenterName: pres.presenterName,
      controlSurfaceAllowed: !!pres.controlSurfaceAllowed
    });
  }
  toast(mode === 'screen' ? 'Screen presentation active' : 'Presentation slides opened on stage', 'good');
}

function closePresentation(broadcast = true) {
  const pres = S.presentation;
  if (broadcast && pres.active && pres.presenterId && pres.presenterId !== S.selfId) {
    toast('Only the presenter can stop this presentation', 'bad');
    return;
  }
  const stream = pres.screenStream;
  if (document.fullscreenElement === E.qSharedStage) void document.exitFullscreen().catch(() => {});
  pres.screenStream = null;
  pres.controlSurfaceAllowed = false;
  if (stream) {
    for (const track of stream.getTracks()) { try { track.stop(); } catch (_) {} }
  }
  pres.active = false;
  pres.presenterId = null;
  pres.presenterName = '';
  pres.mode = 'slides';
  E.qSharedStage.hidden = true;
  E.qPresentBtn?.classList.remove('primary');
  E.qPresentDockBtn?.setAttribute('aria-pressed', 'false');
  E.qScreenVideo.hidden = true;
  E.qScreenVideo.srcObject = null;
  E.qSlidesWrapper.hidden = false;
  E.qScreenVideo.classList.remove('q-control-enabled');
  E.qScreenVideo.classList.remove('q-screen-fill');
  pres.screenFit = 'fit';
  E.qPresentationStatus.textContent = 'Presentation ready';
  syncPresentationControls();
  void replaceVideoTrack(currentOutgoingVideoTrack());
  renderRemoteControlUi();
  renderStage();
  if (broadcast) send({ type: 'presentation:state', active: false, presenterId: S.selfId });
  toast('Presentation closed');
}

function renderSlide(index, broadcast = true) {
  const pres = S.presentation;
  const count = PRESENTATION_SLIDES.length;
  pres.slideIndex = ((index % count) + count) % count;
  const slide = PRESENTATION_SLIDES[pres.slideIndex];
  
  if (E.qSlideCounter) {
    E.qSlideCounter.textContent = `${pres.slideIndex + 1} / ${count}`;
  }
  
  const featHtml = slide.features.map(f => `
    <div class="q-slide-feat-card">
      <strong>${escapeHtml(f.title)}</strong>
      <span>${escapeHtml(f.note)}</span>
    </div>`).join('');

  E.qSlidesWrapper.innerHTML = `
    <div class="q-slide-card">
      <div>
        <span class="q-slide-tag">${escapeHtml(slide.tag)}</span>
        <h2 class="q-slide-title">${escapeHtml(slide.title)}</h2>
        <p class="q-slide-body">${escapeHtml(slide.lead)}</p>
      </div>
      <div class="q-slide-features">${featHtml}</div>
    </div>`;

  if (broadcast && pres.presenterId === S.selfId) {
    send({
      type: 'presentation:state',
      active: true,
      mode: pres.mode,
      slideIndex: pres.slideIndex,
      presenterId: pres.presenterId,
      presenterName: pres.presenterName
    });
  }
}

function nextSlide() {
  renderSlide(S.presentation.slideIndex + 1);
}

function prevSlide() {
  renderSlide(S.presentation.slideIndex - 1);
}

async function startScreenShare() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('Screen sharing is unavailable in this browser', 'bad');
    return;
  }
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'monitor', cursor: 'always' }, audio: false });
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('No display video track was created');
    const settings = track.getSettings?.() || {};
    S.presentation.screenStream = stream;
    setScreenFit('fit');
    S.presentation.controlSurfaceAllowed = settings.displaySurface === 'monitor';
    E.qScreenVideo.srcObject = stream;
    E.qScreenVideo.hidden = false;
    await E.qScreenVideo.play().catch(() => {});
    if (!(await replaceVideoTrack(track))) throw new Error('Could not connect the shared display to every participant');
    track.addEventListener('ended', () => {
      if (S.presentation.screenStream === stream) closePresentation();
    }, { once: true });
    openPresentation('screen');
    if (!S.presentation.controlSurfaceAllowed) {
      toast('Screen shared. Choose a full display to enable remote control.');
    }
  } catch (err) {
    if (stream) {
      for (const track of stream.getTracks()) { try { track.stop(); } catch (_) {} }
    }
    if (S.presentation.screenStream === stream) S.presentation.screenStream = null;
    S.presentation.controlSurfaceAllowed = false;
    if (E.qScreenVideo.srcObject === stream) E.qScreenVideo.srcObject = null;
    E.qScreenVideo.hidden = true;
    void replaceVideoTrack(currentOutgoingVideoTrack());
    syncPresentationControls();
    toast(err?.message || 'Screen share cancelled or unavailable', 'bad');
  }
}
function renderRemoteControlUi() {
  if (!E.qRemoteControlStatus || !S.room) return;
  const control = S.room.remoteControl || {};
  const host = isHost();
  const presentation = S.room.presentation || {};
  const hostSharing = !!(presentation.active && presentation.mode === 'screen' && presentation.presenterId === S.room.hostId);
  const requester = control.requesterId && S.room.participants.find((p) => p.id === control.requesterId);
  const controller = control.controllerId && S.room.participants.find((p) => p.id === control.controllerId);
  const ownRequest = control.requesterId === S.selfId;
  const ownControl = control.controllerId === S.selfId;
  const available = !!control.supported && !!control.screenShared;
  const controlReady = available && !control.controllerId && !control.requesterId;

  E.qRemoteShareBtn.hidden = !host || hostSharing;
  E.qRemoteShareStopBtn.hidden = !host || !hostSharing;
  E.qRemoteControlRequestBtn.hidden = host || (!controlReady && !ownRequest && !ownControl);
  E.qRemoteControlGrantBtn.hidden = !host || !requester || !hostSharing || !control.supported;
  E.qRemoteControlDenyBtn.hidden = !host || !requester;
  E.qRemoteControlRevokeBtn.hidden = !host || !controller;
  E.qRemoteControlRequestBtn.textContent = ownControl ? 'Release control' : ownRequest ? 'Cancel request' : 'Request control';
  E.qRemoteControlGrantBtn.textContent = requester ? 'Allow ' + requester.name : 'Allow control';

  let status = 'The host can share the primary display. Control stays off until the host approves one person.';
  if (!control.supported) {
    status = 'Remote input is available when Quorum runs on the Windows computer being shared.';
  } else if (!hostSharing) {
    status = host ? 'Share the primary display to let one participant request control.' : 'Waiting for the host to share the primary display.';
  } else if (controller) {
    status = host ? controller.name + ' is controlling this display. Revoke access at any time.' :
      (ownControl ? 'You are controlling the host display. Select the shared screen to send mouse and keyboard input.' :
      controller.name + ' has control of the host display.');
  } else if (requester) {
    status = host ? requester.name + ' is requesting control.' :
      (ownRequest ? 'Your request is waiting for the host.' : requester.name + ' is waiting for host approval.');
  } else if (available) {
    status = host ? 'Primary display shared. Approve one participant to enable control.' :
      'Primary display shared. Request control from the host to interact with it.';
  } else {
    status = 'The screen is shared, but this browser did not confirm a full display. Remote control stays off.';
  }
  E.qRemoteControlStatus.textContent = status;
  E.qRemoteControlCard.classList.toggle('q-control-active', !!controller);
  if (S.presentation.active && S.presentation.mode === 'screen') {
    E.qPresentationStatus.textContent = controller ? (host ? controller.name + ' has host-approved control' : ownControl ? 'You have host-approved control' : controller.name + ' has control') : (host ? 'Sharing the host display' : S.presentation.presenterName + ' is sharing a display');
  }
  E.qScreenVideo.classList.toggle('q-control-enabled', ownControl);
  E.qRemoteCursor.hidden = !ownControl;
}

function screenPoint(event) {
  const video = E.qScreenVideo;
  const rect = video.getBoundingClientRect();
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!rect.width || !rect.height || !width || !height) return null;
  const scale = getComputedStyle(video).objectFit === 'cover'
    ? Math.max(rect.width / width, rect.height / height)
    : Math.min(rect.width / width, rect.height / height);
  const contentWidth = width * scale;
  const contentHeight = height * scale;
  const offsetX = (rect.width - contentWidth) / 2;
  const offsetY = (rect.height - contentHeight) / 2;
  const x = (event.clientX - rect.left - offsetX) / contentWidth;
  const y = (event.clientY - rect.top - offsetY) / contentHeight;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

function canControlRemoteScreen() {
  return !!(S.room?.remoteControl?.screenShared && S.room.remoteControl.controllerId === S.selfId && S.presentation.active && S.presentation.mode === 'screen');
}

let remoteControlPointerId = null;
let remoteControlPointerButton = 'left';
let lastRemotePointerAt = 0;
const remoteHeldKeys = new Set();

function sendRemotePointer(event, force = false) {
  const point = screenPoint(event);
  if (!point) return null;
  const now = performance.now();
  if (force || now - lastRemotePointerAt >= 14) {
    send({ type: 'remote-control:input', input: { type: 'move', x: point.x, y: point.y } });
    lastRemotePointerAt = now;
  }
  E.qRemoteCursor.style.left = (point.x * 100) + '%';
  E.qRemoteCursor.style.top = (point.y * 100) + '%';
  return point;
}

function onRemoteScreenPointerDown(event) {
  if (!canControlRemoteScreen()) return;
  const point = sendRemotePointer(event, true);
  if (!point) return;
  event.preventDefault();
  E.qScreenVideo.focus();
  remoteControlPointerId = event.pointerId;
  try { E.qScreenVideo.setPointerCapture(event.pointerId); } catch (_) {}
  remoteControlPointerButton = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left';
  send({ type: 'remote-control:input', input: { type: 'button-down', button: remoteControlPointerButton } });
}

function onRemoteScreenPointerMove(event) {
  if (!canControlRemoteScreen()) return;
  if (remoteControlPointerId !== null && event.pointerId !== remoteControlPointerId) return;
  sendRemotePointer(event);
}

function onRemoteScreenPointerUp(event) {
  if (remoteControlPointerId === null || event.pointerId !== remoteControlPointerId) return;
  sendRemotePointer(event, true);
  send({ type: 'remote-control:input', input: { type: 'button-up', button: remoteControlPointerButton } });
  remoteControlPointerId = null;
  remoteControlPointerButton = 'left';
}

function onRemoteScreenWheel(event) {
  if (!canControlRemoteScreen()) return;
  event.preventDefault();
  sendRemotePointer(event, true);
  send({ type: 'remote-control:input', input: { type: 'wheel', delta: clamp(event.deltaY, -120, 120) } });
}

function onRemoteScreenKeyDown(event) {
  if (!canControlRemoteScreen() || document.activeElement !== E.qScreenVideo) return;
  if (!Number.isInteger(event.keyCode) || event.keyCode <= 0 || event.keyCode >= 256) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (remoteHeldKeys.has(event.keyCode)) return;
  remoteHeldKeys.add(event.keyCode);
  send({ type: 'remote-control:input', input: { type: 'key-down', keyCode: event.keyCode } });
}

function onRemoteScreenKeyUp(event) {
  if (!remoteHeldKeys.has(event.keyCode)) return;
  remoteHeldKeys.delete(event.keyCode);
  send({ type: 'remote-control:input', input: { type: 'key-up', keyCode: event.keyCode } });
  if (canControlRemoteScreen() && document.activeElement === E.qScreenVideo) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}

function releaseRemoteScreenInput() {
  for (const keyCode of remoteHeldKeys) {
    send({ type: 'remote-control:input', input: { type: 'key-up', keyCode } });
  }
  remoteHeldKeys.clear();
  if (remoteControlPointerId !== null) {
    send({ type: 'remote-control:input', input: { type: 'button-up', button: remoteControlPointerButton } });
    remoteControlPointerId = null;
    remoteControlPointerButton = 'left';
  }
}

function handleRemotePresentationState(msg) {
  if (!msg) return;
  if (!msg.active) {
    if (msg.presenterId && S.presentation.presenterId && msg.presenterId !== S.presentation.presenterId) return;
    if (S.presentation.active) closePresentation(false);
    renderRemoteControlUi();
    return;
  }
  S.presentation.active = true;
  S.presentation.mode = msg.mode === 'screen' ? 'screen' : 'slides';
  S.presentation.slideIndex = Number.isInteger(msg.slideIndex) ? msg.slideIndex : 0;
  S.presentation.presenterId = msg.presenterId || null;
  S.presentation.presenterName = msg.presenterName || 'Presenter';
  E.qSharedStage.hidden = false;
  if (S.presentation.mode === 'slides') {
    E.qScreenVideo.hidden = true;
    E.qSlidesWrapper.hidden = false;
    E.qScreenVideo.srcObject = null;
    renderSlide(S.presentation.slideIndex, false);
    E.qPresentationStatus.textContent = S.presentation.presenterName + ' is presenting slides';
  } else if (S.presentation.mode === 'screen') {
    E.qSlidesWrapper.hidden = true;
    E.qScreenVideo.hidden = false;
    const stream = S.presentation.presenterId === S.selfId ? S.presentation.screenStream : S.peers.get(S.presentation.presenterId)?.remoteStream;
    if (stream && E.qScreenVideo.srcObject !== stream) {
      E.qScreenVideo.srcObject = stream;
      E.qScreenVideo.play().catch(() => {});
    }
    E.qPresentationStatus.textContent = S.presentation.presenterName + ' is sharing a display';
  }
  syncPresentationControls();
  renderStage();
  renderRemoteControlUi();
}/* ================================================================== */
/* Boot                                                                */
/* ================================================================== */

window.QuorumFocusBridge = {
  send,
  leave: () => leaveSpace({ silent: true }),
  read: () => ({
    joined: S.joined, room: S.room, selfId: S.selfId, isHost: isHost(),
    focus: S.focus, pendingSummary: S.pendingFocusSummary
  })
};

window.QuorumWorkspaceBridge = {
  send,
  read: () => ({ joined: S.joined, room: S.room, selfId: S.selfId, isHost: isHost() })
};

initJoinScreen();
bindControls();
