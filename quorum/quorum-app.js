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
    (['localhost', '127.0.0.1', '::1'].includes(location.hostname)
      ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/quorum-space`
      : `wss://${location.hostname.endsWith('.onrender.com') ? location.host : 'velos-workspace.onrender.com'}/quorum-space`),
  rtcConfig: {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
    ]
  },
  gesture: {
    bufferSize: 5,
    confidenceFrames: 3,
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
  joined: false,
  intentionalLeave: false,
  heartbeat: null,
  reconnectAttempts: 0,
  roomId: '',
  profile: { position: '', rank: '', skillsets: '', department: '' },
  selfId: '',
  room: null,
  prev: null, /* previous snapshot, for diff toasts */

  localStream: null,
  pendingStream: null,
  mediaReady: null,
  cameraTrack: null,
  cameraFacingMode: 'user',
  switchingCamera: false,
  micTrack: null,
  micOn: true,
  camOn: true,
  mediaError: null,

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
    landmarker: null,
    loading: false,
    lastVideoTime: -1,
    buffer: [],
    stable: 'none',
    lastActionAt: 0,
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
  'qLeaveBtn', 'qLeaveBtn2', 'qStage', 'qStageEmpty', 'qStageMeta',
  'qHostHint', 'qNewGroupBtn', 'qFacil', 'qFacilSub', 'qGroupSwatch',
  'qGroupName', 'qGroupNote', 'qMemberRow', 'qMotionText', 'qMotionEdit',
  'qMotionInput', 'qMotionSave', 'qBallotState', 'qCountdown',
  'qMotionActions', 'qVoteSeconds', 'qVoteOpenBtn', 'qResetHandsBtn',
  'qVoteCard', 'qVoteMine', 'qGestureBtn', 'qGestureDot', 'qGestureLive',
  'qGestureChip', 'qGestureAction', 'qTally', 'qHands', 'qMicBtn', 'qCamBtn',
  'qHandBtn', 'qCamVideo', 'qFlipCamBtn', 'qHandCursor', 'qToasts',
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
  if (!landmarks || landmarks.length < 21) return 'none';
  const [thumb, index, middle, ring, pinky] = getFingerExtension(landmarks);
  const count = [thumb, index, middle, ring, pinky].filter(Boolean).length;
  if (count === 0) return 'fist';
  if (thumb && pinky && !index && !middle && !ring) return 'shaka';
  if (count >= 4) return 'open';
  if (index && middle && !ring && !pinky) return 'peace';
  if (thumb && !index && !middle && !ring && !pinky) {
    const wrist = landmarks[0];
    const tip = landmarks[4];
    if (tip.y < wrist.y - 0.03) return 'thumbsup';
    if (tip.y > wrist.y + 0.03) return 'thumbsdown';
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

function probeServer() {
  clearTimeout(S.probeTimer);
  if (location.protocol === 'file:' || !location.host) {
    setJoinStatus('Run the Quorum server, then open http://localhost:8788/quorum/', 'bad');
    return;
  }
  const urls = getWebSocketUrls();
  const publicBackend = urls.some((url) => !isLocalWebSocketUrl(url));
  setJoinStatus(publicBackend ? 'Connecting to the Quorum service…' : 'Checking server…', '');
  const tryNext = (index) => {
    if (S.joined || index >= urls.length) {
      if (!S.joined) {
        setJoinStatus(serverUnavailableMessage(), 'bad');
        S.probeTimer = setTimeout(probeServer, publicBackend ? 10000 : 4000);
      }
      return;
    }

    let probe;
    try {
      probe = new WebSocket(urls[index]);
    } catch (_) {
      tryNext(index + 1);
      return;
    }
    let settled = false;
    const failed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tryNext(index + 1);
    };
    const timer = setTimeout(() => {
      try { probe.close(); } catch (_) { /* noop */ }
      failed();
    }, publicBackend ? 15000 : 1600);
    probe.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { probe.close(); } catch (_) { /* noop */ }
      if (!S.joined) setJoinStatus('Server online', 'good');
    }, { once: true });
    probe.addEventListener('error', failed, { once: true });
  };
  tryNext(0);
}

function getWebSocketUrls() {
  const configuredUrl = window.QUORUM_CONFIG?.wsUrl;
  if (configuredUrl) return [configuredUrl];
  if (location.protocol === 'file:' || !location.host) return ['ws://localhost:8788/quorum-space'];

  const primary = CFG.wsUrl;
  const host = location.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (isLoopback && location.protocol === 'http:' && location.port !== '8788') {
    return [primary, `ws://${location.hostname}:8788/quorum-space`];
  }
  return [primary];
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
  let endpoint = 'the configured Render service';
  try { endpoint = new URL(CFG.wsUrl).host; } catch (_) { /* keep generic endpoint label */ }
  return `Quorum room service is unavailable at ${endpoint}. Confirm the Render service is deployed and active, then retry.`;
}

function setJoinStatus(text, mode) {
  E.qJoinStatus.innerHTML = `<span class="q-dot ${mode === 'good' ? 'live' : mode === 'bad' ? 'bad' : ''}"></span>${escapeHtml(text)}`;
}

/* ================================================================== */
/* WebSocket                                                           */
/* ================================================================== */

function connectSocket() {
  const urls = getWebSocketUrls();
  return urls.slice(1).reduce(
    (attempt, url) => attempt.catch(() => connectSocketAt(url)),
    connectSocketAt(urls[0])
  );
}

function connectSocketAt(url) {
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
    const timer = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        try { ws.close(); } catch (_) { /* noop */ }
        reject(new Error('Quorum server is not reachable.'));
      }
    }, isLocalWebSocketUrl(url) ? 12000 : 90000);

    ws.addEventListener('open', () => {
      clearTimeout(timer);
      startHeartbeat();
      resolve(ws);
    }, { once: true });
    ws.addEventListener('message', (event) => {
      if (S.socket === ws) void onSocketMessage(event);
    });
    ws.addEventListener('close', () => {
      if (S.socket !== ws) return;
      S.socket = null;
      onSocketClose();
    });
    ws.addEventListener('error', () => {
      if (ws.readyState !== WebSocket.OPEN) {
        clearTimeout(timer);
        reject(new Error('Connection error'));
      }
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
  S.heartbeat = setInterval(() => send({ type: 'ping', at: Date.now() }), CFG.heartbeatMs);
}
function stopHeartbeat() {
  if (S.heartbeat) clearInterval(S.heartbeat);
  S.heartbeat = null;
}

async function joinRoom(code, name, minted, profile = readProfile()) {
  clearTimeout(S.probeTimer);
  E.qJoinBtn.disabled = true;
  E.qOpenBtn.disabled = true;
  S.profile = profile;
  setJoinStatus('Connecting to the room…', '');
  try {
    await connectSocket();
  } catch (err) {
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

  S.roomId = code;
  S.intentionalLeave = false;
  storageSet('quorum.room', code);
  send({ type: 'join', roomId: code, name, minted, profile: S.profile });
}

function onSocketClose() {
  stopHeartbeat();
  finishHostHandDrag();
  if (S.intentionalLeave) return;
  if (S.joined) {
    toast('Connection lost — reconnecting…', 'bad');
    S.joined = false;
    closeAllPeers();
    S.selfId = '';
    S.room = null;
    S.prev = null;
    S.drag = null;
    tryReconnect();
  } else {
    setJoinStatus(serverUnavailableMessage(), 'bad');
    E.qJoinBtn.disabled = false;
    E.qOpenBtn.disabled = false;
  }
}

async function tryReconnect() {
  if (S.reconnectAttempts >= 5 || S.intentionalLeave) {
    leaveSpace({ silent: true });
    toast('Could not reconnect — back to the door', 'bad');
    return;
  }
  S.reconnectAttempts += 1;
  await new Promise((r) => setTimeout(r, 2500));
  if (S.intentionalLeave || S.joined) return;
  try {
    await connectSocket();
    S.reconnectAttempts = 0;
    const name = storageGet('quorum.name') || 'Guest';
    send({ type: 'join', roomId: S.roomId, name, profile: S.profile });
  } catch (_) {
    tryReconnect();
  }
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
      S.selfId = msg.selfId;
      S.joined = true;
      S.reconnectAttempts = 0;
      S.prev = null;
      applyState(msg.room, 'joined');
      enterSpace();
      return;
    }
    case 'peer-joined': {
      applyState(msg.room, 'peer-joined');
      /* We are already in the room: we reach out with the offer. */
      if (msg.participant?.id && S.joined) {
        const socket = S.socket;
        const roomId = msg.room?.id || S.roomId;
        if (S.mediaReady) await S.mediaReady;
        if (!S.joined || S.socket !== socket || S.room?.id !== roomId) return;
        const peer = ensurePeer(msg.participant.id);
        peer.pc.createOffer()
          .then((offer) => peer.pc.setLocalDescription(offer))
          .then(() => signal(msg.participant.id, { description: peer.pc.localDescription }))
          .catch((err) => console.error('mesh offer failed', err));
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
      setJoinStatus(`Room full (${msg.maxParticipants})`, 'bad');
      E.qJoinBtn.disabled = false;
      E.qOpenBtn.disabled = false;
      S.intentionalLeave = true;
      S.socket?.close();
      return;
    }
    case 'error': {
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
  if (S.localStream) return S.localStream;
  const out = new MediaStream();
  S.pendingStream = out;
  const socketAtStart = S.socket;
  const roomAtStart = S.roomId;
  const stillInRoom = () => S.joined && S.socket === socketAtStart && S.roomId === roomAtStart;
  const discard = () => {
    for (const track of out.getTracks()) {
      try { track.stop(); } catch (_) { /* noop */ }
    }
    if (S.pendingStream === out) S.pendingStream = null;
  };

  try {
    const camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'user' }, width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 24, max: 30 } },
      audio: false
    });
    if (!stillInRoom()) {
      for (const track of camStream.getTracks()) track.stop();
      discard();
      return null;
    }
    S.cameraTrack = camStream.getVideoTracks()[0] || null;
    if (S.cameraTrack) {
      S.cameraFacingMode = S.cameraTrack.getSettings?.().facingMode || 'user';
      S.cameraTrack.enabled = S.camOn;
      out.addTrack(S.cameraTrack);
    } else S.camOn = false;
  } catch (err) {
    if (!stillInRoom()) {
      discard();
      return null;
    }
    S.mediaError = 'Camera unavailable — you will appear as an avatar box.';
    S.camOn = false;
  }

  try {
    const micStream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    if (!stillInRoom()) {
      for (const track of micStream.getTracks()) track.stop();
      discard();
      return null;
    }
    S.micTrack = micStream.getAudioTracks()[0] || null;
    if (S.micTrack) {
      S.micTrack.enabled = S.micOn;
      out.addTrack(S.micTrack);
    } else S.micOn = false;
  } catch (err) {
    if (!stillInRoom()) {
      discard();
      return null;
    }
    S.micOn = false;
  }

  if (!stillInRoom()) {
    discard();
    return null;
  }
  S.localStream = out;
  S.pendingStream = null;
  E.qCamVideo.srcObject = S.cameraTrack ? out : null;
  if (S.cameraTrack) {
    E.qCamVideo.play().catch(() => { /* autoplay guard */ });
    startGestureEngine();
  }
  renderStage();
  syncDock();
  send({ type: 'presence', micOn: S.micOn, camOn: S.camOn });
  return out;
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

function toggleMic() {
  if (!S.micTrack) {
    toast('No microphone available on this device', 'bad');
    return;
  }
  S.micOn = !S.micOn;
  S.micTrack.enabled = S.micOn;
  syncDock();
  send({ type: 'presence', micOn: S.micOn });
}

async function toggleCam() {
  if (!S.cameraTrack) {
    toast('No camera available on this device', 'bad');
    return;
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
    renderStage();
    syncDock();
  }
}

function ensurePeer(peerId) {
  if (S.peers.has(peerId)) return S.peers.get(peerId);

  const pc = new RTCPeerConnection(CFG.rtcConfig);
  const peer = { id: peerId, pc, remoteStream: new MediaStream(), queued: [] };
  S.peers.set(peerId, peer);

  if (S.localStream) {
    const outgoing = currentOutgoingVideoTrack();
    for (const track of S.localStream.getTracks()) {
      if (track.kind === 'video') {
        const sender = pc.addTrack(outgoing || track, S.localStream);
        sender.__qVideo = true;
        if (!outgoing) void sender.replaceTrack(null);
      } else {
        pc.addTrack(track, S.localStream);
      }
    }
  }
  if (!pc.getSenders().some((sender) => sender.__qVideo || sender.track?.kind === 'video')) {
    try {
      const transceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
      transceiver.sender.__qVideo = true;
    } catch (err) {
      console.error('Quorum could not prepare a video sender', err);
    }
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) signal(peerId, { candidate: event.candidate });
  };

  pc.ontrack = (event) => {
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
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected') {
      setTimeout(() => {
        if (pc.connectionState === 'disconnected') {
          try { pc.restartIce(); } catch (_) { /* noop */ }
        }
      }, 2000);
      return;
    }
    if (['failed', 'closed'].includes(pc.connectionState)) closePeer(peerId);
  };

  return peer;
}

function signal(targetId, signalData) {
  send({ type: 'signal', targetId, signal: signalData });
}

async function handleSignal(fromId, signalData) {
  if (!fromId || !signalData) return;
  const peer = ensurePeer(fromId);
  try {
    if (signalData.description) {
      const description = new RTCSessionDescription(signalData.description);
      await peer.pc.setRemoteDescription(description);
      for (const candidate of peer.queued.splice(0)) {
        try { await peer.pc.addIceCandidate(candidate); } catch (_) { /* noop */ }
      }
      if (description.type === 'offer') {
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        signal(fromId, { description: peer.pc.localDescription });
      }
      return;
    }
    if (signalData.candidate) {
      const candidate = new RTCIceCandidate(signalData.candidate);
      if (peer.pc.remoteDescription) {
        await peer.pc.addIceCandidate(candidate);
      } else {
        peer.queued.push(candidate);
      }
    }
  } catch (err) {
    console.error('WebRTC error', err);
  }
}

function attachRemoteStream(peerId, stream) {
  const box = [...E.qStage.querySelectorAll('.q-box')].find((item) => item.dataset.id === peerId);
  const video = box?.querySelector('video');
  if (video && video.srcObject !== stream) {
    video.srcObject = stream;
    video.play().catch(() => { /* autoplay guard */ });
  }
  if (S.presentation.active && S.presentation.mode === 'screen' && S.presentation.presenterId === peerId && E.qScreenVideo.srcObject !== stream) {
    E.qScreenVideo.srcObject = stream;
    E.qScreenVideo.play().catch(() => { /* autoplay guard */ });
  }
}

function closePeer(peerId) {
  const peer = S.peers.get(peerId);
  if (peer) {
    try { peer.pc.close(); } catch (_) { /* noop */ }
    S.peers.delete(peerId);
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
  S.mediaReady = acquireMedia();
}

function leaveSpace({ silent = false } = {}) {
  S.intentionalLeave = true;
  S.joined = false;
  stopHeartbeat();
  stopGestureEngine();
  closeAllPeers();
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
  try { S.socket?.close(); } catch (_) { /* noop */ }
  S.socket = null;

  document.body.dataset.mode = 'join';
  E.qMeet.hidden = true;
  E.qJoin.hidden = false;
  E.qStage.querySelectorAll('.q-box, .q-group').forEach((el) => el.remove());
  S.room = null;
  S.prev = null;
  probeServer();
  if (!silent) toast('You left the space');
}

/* ================================================================== */
/* State application + rendering                                       */
/* ================================================================== */

function applyState(room, reason) {
  if (!room) return;
  const previousPresentation = S.room?.presentation;
  S.prev = S.room;
  S.room = room;
  S.roomId = room.id || S.roomId;
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
}

function renderTopbar() {
  const room = S.room;
  E.qRoomLabel.textContent = room.id;
  const host = room.participants.find((p) => p.id === room.hostId);
  E.qHostLabel.textContent = `Host — ${host ? host.name : '—'}`;
  E.qPeopleCount.textContent = `${room.participants.length} in space`;

  const online = S.socket?.readyState === WebSocket.OPEN;
  E.qConnDot.classList.toggle('bad', !online);

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
  const stage = E.qStage;

  stage.classList.toggle('empty', room.participants.length === 0);

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
    el.style.borderColor = group.color;
    el.style.color = group.color;
    const members = room.participants.filter((p) => p.groupId === group.id);
    el.querySelector('.q-group-name').textContent = group.name;
    el.querySelector('.q-group-count').textContent = `${members.length} 👤`;
    el.querySelector('.q-group-head').style.borderColor = group.color;
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
    ? `${room.participants.length} bound · ${room.groups.length} ${groupWord}`
    : 'Everyone is bound by a box';
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
    ? 'You are bound to this group. The host can move you at any time.'
    : 'The host will drag your box into a group.';
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
    if (!isHost() || ev.button !== 0) return;
    ev.preventDefault();
    const id = el.dataset.id;
    S.drag = { kind: 'box', id, el, moved: false };
    el.setPointerCapture(ev.pointerId);
    el.classList.add('dragging');
  });

  el.addEventListener('pointermove', (ev) => {
    if (S.drag?.kind !== 'box' || S.drag.el !== el) return;
    const point = stagePointToNormalized(ev);
    S.drag.moved = true;
    el.style.left = `${point.x * 100}%`;
    el.style.top = `${point.y * 100}%`;
    highlightGroupAt(point);
    const now = performance.now();
    if (now - S.lastDragSend >= CFG.dragThrottleMs) {
      S.lastDragSend = now;
      send({ type: 'host:move', peerId: id, x: point.x, y: point.y });
    }
  });

  const finish = (ev) => {
    if (S.drag?.kind !== 'box' || S.drag.el !== el) return;
    const id = S.drag.id;
    const moved = S.drag.moved;
    S.drag = null;
    el.classList.remove('dragging');
    clearGroupHighlight();
    if (!moved) return;

    const point = stagePointToNormalized(ev);
    const target = selfParticipant();
    const current = S.room?.participants.find((p) => p.id === id);
    if (!current) return;
    const over = groupUnderPoint(point);
    const nextGroup = over ? over.id : null;
    send({ type: 'host:move', peerId: id, x: point.x, y: point.y, groupId: nextGroup });
    void target;
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
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
  E.qProfileViewStage.textContent = `${Math.round(participant.box.x * 100)}% across · ${Math.round(participant.box.y * 100)}% down`;
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
    if (ev.target.closest('.q-group-x')) return;
    if (head.querySelector('.q-rename-input')) return; /* renaming in progress */
    ev.preventDefault();
    S.drag = { kind: 'group', id: el.dataset.id, el, moved: false };
    el.setPointerCapture(ev.pointerId);
    el.classList.add('dragging');
  });

  head.addEventListener('pointermove', (ev) => {
    if (S.drag?.kind !== 'group' || S.drag.el !== el) return;
    const point = stagePointToNormalized(ev);
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
    if (S.drag?.kind !== 'group' || S.drag.el !== el) return;
    const moved = S.drag.moved;
    S.drag = null;
    el.classList.remove('dragging');
    if (!moved) return;
    const point = stagePointToNormalized(ev);
    send({ type: 'host:group-update', groupId: el.dataset.id, x: point.x, y: point.y });
  };
  head.addEventListener('pointerup', finish);
  head.addEventListener('pointercancel', finish);

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
  const handX = 1 - palm.x; /* mirror the local preview, like Velos Air Mouse */
  const handY = palm.y;
  if (!Number.isFinite(handX) || !Number.isFinite(handY) || !rect.width || !rect.height) {
    finishHostHandDrag();
    return;
  }

  E.qHandCursor.hidden = false;
  E.qHandCursor.style.left = `${clamp(handX, 0, 1) * rect.width}px`;
  E.qHandCursor.style.top = `${clamp(handY, 0, 1) * rect.height}px`;

  const point = {
    x: clamp(handX, 0.02, 0.98),
    y: clamp(handY, 0.02, 0.98)
  };
  const clientX = rect.left + point.x * rect.width;
  const clientY = rect.top + point.y * rect.height;

  if (stable !== 'fist') {
    finishHostHandDrag();
    E.qHandCursor.hidden = false;
    return;
  }
  if (!S.handDrag) beginHostHandDrag(clientX, clientY, point);
  const drag = S.handDrag;
  if (!drag) return;

  const next = {
    x: clamp(point.x + drag.offsetX, 0.02, 0.98),
    y: clamp(point.y + drag.offsetY, 0.02, 0.98)
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
  if (!g.wanted || g.active || g.loading || !S.cameraTrack || !S.camOn) return;
  g.loading = true;
  setGestureHud('loading model…');
  syncDock();

  try {
    const vision = await withTimeout(import(MEDIAPIPE_BUNDLE), 12000, 'MediaPipe library load');
    const fileset = await withTimeout(
      vision.FilesetResolver.forVisionTasks(MEDIAPIPE_WASM),
      12000,
      'MediaPipe runtime load'
    );
    const options = {
      baseOptions: { modelAssetPath: HAND_MODEL_URL },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.55
    };
    try {
      g.landmarker = await withTimeout(
        vision.HandLandmarker.createFromOptions(fileset, {
          ...options,
          baseOptions: { ...options.baseOptions, delegate: 'GPU' }
        }),
        8500,
        'GPU hand tracking initialization'
      );
    } catch (gpuError) {
      console.warn('GPU hand tracking unavailable; retrying with CPU.', gpuError);
      setGestureHud('GPU unavailable · switching to CPU…');
      g.landmarker = await withTimeout(
        vision.HandLandmarker.createFromOptions(fileset, options),
        13000,
        'CPU hand tracking initialization'
      );
    }

    if (!S.joined || !g.wanted || !S.cameraTrack || !S.camOn) {
      try { g.landmarker?.close(); } catch (_) { /* noop */ }
      g.landmarker = null;
      g.loading = false;
      syncDock();
      return;
    }
    g.active = true;
    g.loading = false;
    setGestureHud('ready');
    syncDock();
    gestureLoop();
  } catch (err) {
    console.warn('Gesture engine unavailable:', err);
    g.loading = false;
    g.active = false;
    g.wanted = false;
    setGestureHud('unavailable · check internet, then retry');
    syncDock();
    toast('Hand tracking could not load. Check internet access, then try Gestures again.', 'bad');
  }
}

function stopGestureEngine() {
  const g = S.gesture;
  finishHostHandDrag();
  g.active = false;
  if (g.rafId) cancelAnimationFrame(g.rafId);
  g.rafId = 0;
  try { g.landmarker?.close(); } catch (_) { /* noop */ }
  g.landmarker = null;
  g.buffer = [];
  g.stable = 'none';
  g.openSince = 0;
  g.lastDiscrete = null;
  E.qGestureLive.hidden = true;
}

function gestureLoop() {
  const g = S.gesture;
  if (!g.active) return;
  g.rafId = requestAnimationFrame(gestureLoop);

  const video = E.qCamVideo;
  if (!g.landmarker || video.readyState < 2 || !video.videoWidth) return;

  const now = performance.now();
  if (video.currentTime === g.lastVideoTime) return;
  g.lastVideoTime = video.currentTime;

  let landmarks = null;
  try {
    const result = g.landmarker.detectForVideo(video, now);
    landmarks = result?.landmarks?.[0] || null;
  } catch (_) {
    return; /* transient GPU hiccup; skip this frame */
  }

  const raw = recognizeGesture(landmarks);

  /* Stability buffer — same scheme as the Velos presenter. */
  g.buffer.push(raw);
  while (g.buffer.length > CFG.gesture.bufferSize) g.buffer.shift();
  const counts = new Map();
  for (const item of g.buffer) {
    if (item === 'none') continue;
    counts.set(item, (counts.get(item) || 0) + 1);
  }
  let best = 'none';
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  const stable = bestCount >= CFG.gesture.confidenceFrames ? best : 'none';

  if (stable !== g.stable) {
    if (g.stable === 'open' && stable !== 'open') g.openSince = 0;
    g.stable = stable;
    if (stable === 'open') g.openSince = now;
  }

  E.qGestureChip.textContent = GESTURE_LABEL[stable] || stable;
  E.qGestureAction.textContent = gestureHintFor(stable);
  updateHostHandDrag(landmarks, stable, now);

  /* Open-palm hold = raise / lower hand. */
  if (stable === 'open' && g.openSince && now - g.openSince >= CFG.gesture.openHoldMs) {
    g.openSince = 0; /* one action per hold; release and raise again to toggle */
    if (now - g.lastActionAt >= CFG.gesture.actionCooldownMs) {
      g.lastActionAt = now;
      const me = selfParticipant();
      if (me) {
        send({ type: 'hand', raised: !me.handRaised });
        flashGestureAction(me.handRaised ? '✋ hand lowered' : '✋ hand raised');
      }
    }
  }

  /* Discrete voting gestures. */
  if (stable === 'thumbsup' || stable === 'thumbsdown' || stable === 'peace') {
    if (now - g.lastActionAt >= CFG.gesture.actionCooldownMs && stable !== g.lastDiscrete) {
      g.lastActionAt = now;
      g.lastDiscrete = stable;
      applyGestureVote(stable);
    }
  } else if (stable === 'none') {
    g.lastDiscrete = null;
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
    return;
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
    return;
  }
  send({ type: 'vote', choice, source: 'gesture' });
  flashGestureAction(`${VOTE_META[choice].emoji} voted ${VOTE_META[choice].label}`);
}

function flashGestureAction(text) {
  E.qGestureAction.textContent = text;
}

function setGestureHud(text) {
  E.qGestureLive.hidden = false;
  E.qGestureAction.textContent = text;
}

function toggleGestureEngine() {
  const g = S.gesture;
  if (!g.active) {
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
  E.qGestureBtn.disabled = S.gesture.loading;
  E.qGestureDot.classList.toggle('on', S.gesture.active);
  if (S.gesture.active) {
    E.qGestureLive.hidden = false;
  }
  const me = selfParticipant();
  E.qHandBtn.setAttribute('aria-pressed', String(!!me?.handRaised));
}

function bindControls() {
  E.qMicBtn.addEventListener('click', toggleMic);
  E.qCamBtn.addEventListener('click', () => void toggleCam());
  E.qFlipCamBtn.addEventListener('click', () => void switchCamera());
  E.qGestureBtn.addEventListener('click', toggleGestureEngine);
  E.qHandBtn.addEventListener('click', () => {
    const me = selfParticipant();
    if (me) send({ type: 'hand', raised: !me.handRaised });
  });
  E.qLeaveBtn.addEventListener('click', () => leaveSpace());
  E.qLeaveBtn2.addEventListener('click', () => leaveSpace());
  E.qProfileCloseBtn?.addEventListener('click', () => E.qProfileDialog.close());
  E.qProfileDialog?.addEventListener('click', (ev) => {
    if (ev.target === E.qProfileDialog) E.qProfileDialog.close();
  });

  E.qRoomChip.addEventListener('click', () => void copyInviteLink());
  E.qInviteBtn?.addEventListener('click', () => void copyInviteLink());

  E.qNewGroupBtn.addEventListener('click', () => {
    const count = S.room?.groups.length || 0;
    send({ type: 'host:group-create', name: `Group ${count + 1}` });
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
    lead: 'Everyone has a place on the stage. The host moves boxes, forms groups, and keeps the round visible.',
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

initJoinScreen();
bindControls();
