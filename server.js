/**
 * Velos + Quorum — merged production server
 * ------------------------------------------------------------------
 * One command runs the whole platform:
 *
 *     npm install
 *     node server.js
 *     open http://localhost:8788
 *
 * Responsibilities:
 *   1. Static hosting for the Velos site (landing + presenter app)
 *      and the Quorum Space (facilitated video rounds).
 *   2. Authoritative WebSocket endpoint at /quorum-space:
 *      bound participant boxes, host drag-and-drop, groups,
 *      a facilitation center with motions and gesture-driven voting,
 *      plus WebRTC signaling relay for the peer-to-peer mesh.
 *
 * Model (same as Velos Room): the server is the single source of
 * truth. Clients propose actions; the server validates roles,
 * applies them to room state and broadcasts a versioned snapshot.
 * Participants can move themselves and use shared workspace tools. The host
 * manages other participant boxes, groups and ballots.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const remoteInput = require('./remote-input');
const { createRtcConfigProvider } = require('./rtc-config');
const { initFocus, focusTick, applyFocusEvent, focusAverage, computeSessionScore, gradeForScore } = require('./lib/quorum-core.cjs');
const publicRtcConfig = createRtcConfigProvider();
const decisions = require('./lib/decisions.cjs');

const PORT = Number(process.env.PORT || process.env.QUORUM_PORT || 8788);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const WS_PATH = '/quorum-space';
const MAX_PARTICIPANTS = 16;
const MAX_GROUPS = 8;
const MAX_WORKSPACE_TOOLS = 12;
const MAX_WORKSPACE_BYTES = 384 * 1024;
const MAX_TOOL_BYTES = 128 * 1024;
const WORKSPACE_KINDS = new Set(['notes', 'board', 'tasks', 'timer', 'embed']);
const positiveDuration = (value, fallback) => {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : fallback;
};
const SWEEP_MS = positiveDuration(process.env.QUORUM_SWEEP_MS, 1000);
const HEARTBEAT_MS = positiveDuration(process.env.QUORUM_HEARTBEAT_MS, 15000);
const CONNECTION_TIMEOUT_MS = positiveDuration(process.env.QUORUM_CONNECTION_TIMEOUT_MS, 45000);
const RECONNECT_GRACE_MS = positiveDuration(process.env.QUORUM_RECONNECT_GRACE_MS, 90000);
const MAX_BUFFERED_BYTES = 1024 * 1024;
const FOCUS_INTERVAL_MS = 500;
const FOCUS_ACTION_COOLDOWN_MS = 1500;
const ALIGNMENT_FIRST_MS = 45000;
const ALIGNMENT_REPEAT_MS = 75000;
const ALIGNMENT_WINDOW_MS = 10000;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const rid = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

const clean = (value, max = 160) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const roomCode = (value) =>
  clean(value, 48)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || rid('room');

const worldPosition = (value, fallback = 0.5) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(100, Math.max(-100, num));
};

const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validNumber = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const documentText = (value) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

/* Screens only navigate the participant's sandboxed iframe. No server requests
 * or framing-header bypass is performed for third-party tools. */
function workspaceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url;
  try { url = new URL(value); } catch (_) { return null; }
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (loopback && !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(value)) return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  if (!loopback) {
    if (!host.includes('.') || /(?:^|\.)(?:local|internal|localhost|test|invalid)$/.test(host)) return null;
    const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4) {
      const [, first, second] = ipv4.map(Number);
      if (first === 0 || first === 10 || first === 127 || first >= 224 ||
          (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) ||
          (first === 192 && (second === 168 || second === 0)) ||
          (first === 100 && second >= 64 && second <= 127)) return null;
    }
    // Reject literal IPv6 other than loopback; public domain URLs remain usable.
    if (host.includes(':')) return null;
  }
  return url.href;
}

function workspaceData(kind, value) {
  if (!plainObject(value)) throw new Error('This screen needs a valid document.');
  let data;
  if (kind === 'notes') {
    if (typeof value.text !== 'string' || value.text.length > 20000) throw new Error('Notes support up to 20,000 characters.');
    data = { text: documentText(value.text) };
  } else if (kind === 'tasks') {
    if (!Array.isArray(value.items) || value.items.length > 100) throw new Error('A task screen supports up to 100 tasks.');
    const seen = new Set();
    data = { items: value.items.map((item) => {
      if (!plainObject(item) || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) || seen.has(item.id) ||
          typeof item.text !== 'string' || item.text.length > 500 || typeof item.done !== 'boolean') throw new Error('A task has invalid content.');
      seen.add(item.id);
      return { id: item.id, text: documentText(item.text), done: item.done };
    }) };
  } else if (kind === 'board') {
    if (!Array.isArray(value.strokes) || value.strokes.length > 200) throw new Error('A board supports up to 200 strokes.');
    let count = 0;
    const seen = new Set();
    data = { strokes: value.strokes.map((stroke) => {
      if (!plainObject(stroke) || typeof stroke.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(stroke.id) || seen.has(stroke.id) ||
          typeof stroke.color !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(stroke.color) || !validNumber(stroke.width, 1, 20) ||
          !Array.isArray(stroke.points) || stroke.points.length < 1 || (count += stroke.points.length) > 4000) throw new Error('The board contains invalid or too many strokes.');
      seen.add(stroke.id);
      const points = stroke.points.map((point) => {
        if (!plainObject(point) || !validNumber(point.x, 0, 1) || !validNumber(point.y, 0, 1)) throw new Error('Board points must stay inside the screen.');
        return { x: Math.round(point.x * 10000) / 10000, y: Math.round(point.y * 10000) / 10000 };
      });
      return { id: stroke.id, color: stroke.color.toLowerCase(), width: stroke.width, points };
    }) };
  } else if (kind === 'timer') {
    if (!validNumber(value.durationMs, 0, 86400000) || typeof value.running !== 'boolean' ||
        (value.startedAt !== null && !validNumber(value.startedAt, 0, Date.now() + 5000)) ||
        (value.running && value.startedAt === null)) throw new Error('The timer settings are invalid.');
    data = { durationMs: value.durationMs, startedAt: value.running ? value.startedAt : null, running: value.running };
  } else {
    data = {};
  }
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_TOOL_BYTES) throw new Error('This screen has too much content.');
  return data;
}

function defaultWorkspaceData(kind) {
  if (kind === 'notes') return { text: '' };
  if (kind === 'tasks') return { items: [] };
  if (kind === 'board') return { strokes: [] };
  if (kind === 'timer') return { durationMs: 1500000, startedAt: null, running: false };
  return {};
}

function workspaceWithinBudget(room, proposed) {
  const tools = [...room.tools.values()].filter((tool) => tool.id !== proposed.id);
  tools.push(proposed);
  return Buffer.byteLength(JSON.stringify(tools)) <= MAX_WORKSPACE_BYTES;
}

/* Quorum room-code stems — same vocabulary as the Quorum platform. */
const STEMS = [
  'cedar', 'ember', 'flint', 'grove', 'haven', 'ivory', 'lumen', 'moss',
  'north', 'opal', 'pine', 'quartz', 'ridge', 'sage', 'tide', 'umbra',
  'vale', 'wren', 'ash', 'brine', 'cinder', 'dusk', 'fern', 'glen'
];

const mintRoomCode = () => {
  const stem = STEMS[Math.floor(Math.random() * STEMS.length)];
  const tail = Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(2, 4);
  return `${stem}-${(tail + 'k4').slice(0, 2)}`;
};

const GROUP_COLORS = ['#66dfbd', '#aeb6c0', '#8eb9ad', '#d1d5db', '#6f9d90', '#929aa5', '#b5c9c2', '#78838f'];

const VOTE_CHOICES = new Set(['yes', 'no', 'abstain']);

/* Free-slot placement for newcomer boxes (normalized stage coords). */
const FLOOR_SLOTS = (() => {
  const slots = [];
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 6; col += 1) {
      slots.push({
        x: 0.1 + col * 0.16,
        y: 0.14 + row * 0.24
      });
    }
  }
  slots.sort(
    (a, b) =>
      Math.hypot(a.x - 0.5, a.y - 0.5) - Math.hypot(b.x - 0.5, b.y - 0.5)
  );
  return slots;
})();

const GROUP_ANCHORS = [
  { x: 0.19, y: 0.4 },
  { x: 0.5, y: 0.4 },
  { x: 0.81, y: 0.4 },
  { x: 0.34, y: 0.78 },
  { x: 0.66, y: 0.78 }
];

const GROUP_SIZE = { w: 0.3, h: 0.5 };

const rectsOverlap = (a, b) =>
  Math.abs(a.x - b.x) * 2 < a.w + b.w &&
  Math.abs(a.y - b.y) * 2 < a.h + b.h;

const pointInRect = (px, py, rect) =>
  px >= rect.x - rect.w / 2 &&
  px <= rect.x + rect.w / 2 &&
  py >= rect.y - rect.h / 2 &&
  py <= rect.y + rect.h / 2;

/* ------------------------------------------------------------------ */
/* Room model                                                          */
/* ------------------------------------------------------------------ */

const rooms = new Map();
let activeRemoteRoomId = null;

function ensureRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      id: code,
      version: 1,
      hostId: null,
      createdAt: Date.now(),
      participants: new Map(),
      groups: new Map(),
      tools: new Map(),
      decisions: decisions.initDecisions(),
      completedTaskIds: new Set(),
      groupSeq: 0,
      motion: '',
      ballot: { open: false, openedAt: null, closesAt: null },
      presentation: { active: false, mode: 'slides', slideIndex: 0, presenterId: null, presenterName: '', controlSurfaceAllowed: false },
      remoteControlRequestId: null,
      remoteControlControllerId: null,
      lastRemoteInputAt: 0,
      flushTimer: null,
      focus: {
        state: initFocus(),
        sessionId: rid('session'),
        elapsedMs: 0,
        contributions: 0,
        collaborations: 0,
        bestChain: 0,
        chain: 0,
        lastContributorId: null,
        syncsWon: 0,
        drifts: 0,
        alignment: null,
        lastAlignmentStartedAt: null,
        nextAlignmentAt: ALIGNMENT_FIRST_MS,
        lastEvent: null,
        lastTickAt: null,
        timer: null
      }
    });
  }
  return rooms.get(code);
}

function pickBoxSlot(room) {
  const taken = [...room.participants.values()].map((p) => p.box);
  const groupRects = [...room.groups.values()].map((g) => ({
    x: g.x, y: g.y, w: g.w, h: g.h
  }));
  for (const slot of FLOOR_SLOTS) {
    const busy = taken.some((box) => Math.hypot(box.x - slot.x, box.y - slot.y) < 0.15);
    const insideGroup = groupRects.some((rect) => pointInRect(slot.x, slot.y, rect));
    if (!busy && !insideGroup) return { x: slot.x, y: slot.y };
  }
  return {
    x: 0.5 + (Math.random() - 0.5) * 0.6,
    y: 0.5 + (Math.random() - 0.5) * 0.5
  };
}

function pickGroupSlot(room) {
  const existing = [...room.groups.values()].map((g) => ({
    x: g.x, y: g.y, w: g.w, h: g.h
  }));
  for (const anchor of GROUP_ANCHORS) {
    const candidate = { ...anchor, ...GROUP_SIZE };
    if (!existing.some((rect) => rectsOverlap(candidate, rect))) {
      return anchor;
    }
  }
  return {
    x: 0.5 + (Math.random() - 0.5) * 0.4,
    y: 0.5 + (Math.random() - 0.5) * 0.3
  };
}

function tallyVotes(room) {
  const count = (members) => {
    const out = { yes: 0, no: 0, abstain: 0, pending: 0 };
    for (const p of members) {
      if (p.vote === 'yes') out.yes += 1;
      else if (p.vote === 'no') out.no += 1;
      else if (p.vote === 'abstain') out.abstain += 1;
      else out.pending += 1;
    }
    return out;
  };

  const people = [...room.participants.values()];
  const voters = people.filter((p) => p.id !== room.hostId && p.groupId);
  const perGroup = [];
  for (const group of room.groups.values()) {
    perGroup.push({
      groupId: group.id,
      name: group.name,
      color: group.color,
      ...count(voters.filter((p) => p.groupId === group.id))
    });
  }
  const floor = people.filter((p) => p.id !== room.hostId && !p.groupId);
  return {
    open: room.ballot.open,
    perGroup,
    floor: count(floor),
    total: count(voters),
    gestureVotes: voters.reduce((sum, p) => sum + (p.gestureVotes || 0), 0)
  };
}

function serializeParticipant(p) {
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    box: { x: p.box.x, y: p.box.y },
    groupId: p.groupId,
    micOn: !!p.micOn,
    camOn: !!p.camOn,
    handRaised: !!p.handRaised,
    raisedAt: p.raisedAt || null,
    vote: p.vote,
    gestureVotes: p.gestureVotes,
    joinedAt: p.joinedAt,
    connected: !!p.ws && p.ws.readyState === WebSocket.OPEN
  };
}

function cleanProfile(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    position: clean(source.position, 100),
    rank: clean(source.rank, 64),
    skillsets: clean(source.skillsets, 180),
    department: clean(source.department, 100)
  };
}

function serializeGroup(g) {
  return { id: g.id, name: g.name, color: g.color, x: g.x, y: g.y, w: g.w, h: g.h };
}

function remoteControlSnapshot(room) {
  const requester = room.participants.get(room.remoteControlRequestId);
  const controller = room.participants.get(room.remoteControlControllerId);
  const screenShared = remoteInput.isSupported() && room.presentation.active && room.presentation.mode === 'screen' && room.presentation.presenterId === room.hostId && room.presentation.controlSurfaceAllowed;
  return {
    supported: remoteInput.isSupported(),
    screenShared,
    requesterId: requester?.id || null,
    requesterName: requester?.name || null,
    controllerId: controller?.id || null,
    controllerName: controller?.name || null
  };
}

function snapshot(room, viewerId = null) {
  const canViewProfiles = viewerId === room.hostId;
  return {
    id: room.id,
    version: room.version,
    hostId: room.hostId,
    createdAt: room.createdAt,
    participants: [...room.participants.values()].map((participant) => ({
      ...serializeParticipant(participant),
      ...(canViewProfiles ? { profile: { ...participant.profile } } : {})
    })),
    groups: [...room.groups.values()].map(serializeGroup),
    tools: [...room.tools.values()],
    decisions: decisions.decisionSnapshot(room, viewerId),
    motion: room.motion,
    ballot: { ...room.ballot },
    presentation: { ...room.presentation },
    remoteControl: remoteControlSnapshot(room),
    focus: focusSnapshot(room, viewerId),
    tally: tallyVotes(room)
  };
}
function send(ws, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  // Recover a stalled connection instead of accumulating seconds of old state.
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    ws.terminate();
    return;
  }
  try {
    ws.send(JSON.stringify(data));
  } catch (_) { /* socket died mid-write; the close handler cleans up */ }
}

function broadcast(room, data, exceptId = null) {
  for (const p of room.participants.values()) {
    if (p.id === exceptId) continue;
    const payload = data.room ? { ...data, room: snapshot(room, p.id) } : data;
    send(p.ws, payload);
  }
}

/* Coalesce high-frequency layout updates (box / group dragging). */
function broadcastSnapshot(room, reason, exceptId = null) {
  broadcast(room, { type: 'state', reason, room: snapshot(room) }, exceptId);
}

function broadcastLayout(room) {
  if (room.flushTimer) return;
  room.flushTimer = setTimeout(() => {
    room.flushTimer = null;
    room.version += 1;
    broadcastSnapshot(room, 'layout');
  }, 40);
}

function applyMutation(room, reason) {
  room.version += 1;
  broadcastSnapshot(room, reason);
}

function workspaceTaskProgress(room) {
  let itemsTotal = 0;
  let itemsCompleted = 0;
  for (const tool of room.tools.values()) {
    if (tool.kind !== 'tasks') continue;
    itemsTotal += tool.data.items.length;
    itemsCompleted += tool.data.items.filter((item) => item.done).length;
  }
  return { itemsTotal, itemsCompleted };
}

function recordTaskCompletions(room, participant, tool, previous = null) {
  if (tool.kind !== 'tasks') return;
  const oldItems = new Map((previous?.data.items || []).map((item) => [item.id, item]));
  let awarded = false;
  for (const item of tool.data.items) {
    if (!item.done) continue;
    const key = `${tool.id}:${item.id}`;
    if (room.completedTaskIds.has(key)) continue;
    // Bound bookkeeping even in a very long session with heavy task churn.
    if (room.completedTaskIds.size >= 10000) continue;
    room.completedTaskIds.add(key);
    if (oldItems.has(item.id) && !oldItems.get(item.id).done) {
      focusGain(room, participant, 'close', { throttle: false, broadcast: false });
      awarded = true;
    }
  }
  if (awarded) broadcastFocus(room);
}

/* Focus has its own small update stream: video tiles and the stage are not
 * rebuilt for the twice-per-second meter samples. The server owns every gain. */
function focusSnapshot(room, viewerId = null) {
  const focus = room.focus;
  const alignment = focus.alignment;
  const viewer = room.participants.get(viewerId);
  return {
    sessionId: focus.sessionId,
    energy: focus.state.energy,
    history: [...focus.state.history],
    elapsedMs: focus.elapsedMs,
    contributions: focus.contributions,
    collaborations: focus.collaborations,
    bestChain: focus.bestChain,
    syncsWon: focus.syncsWon,
    drifts: focus.drifts,
    ...workspaceTaskProgress(room),
    canStartAlignment: !alignment && alignmentCooldownMs(room) === 0 &&
      [...room.participants.values()].filter((p) => p.ws?.readyState === WebSocket.OPEN).length >= 2,
    nextAlignmentInMs: alignmentCooldownMs(room),
    ...(viewer ? { personal: { contributions: viewer.focusContributions, collaborations: viewer.focusCollaborations } } : {}),
    alignment: alignment ? {
      id: alignment.id,
      startedAt: alignment.startedAt,
      endsAt: Date.now() + Math.max(0, alignment.endsAtElapsed - focus.elapsedMs),
      participantIds: [...alignment.participantIds],
      joinedIds: [...alignment.joinedIds]
    } : null,
    lastEvent: focus.lastEvent
  };
}

function broadcastFocus(room) {
  for (const participant of room.participants.values()) {
    send(participant.ws, { type: 'focus:state', focus: focusSnapshot(room, participant.id) });
  }
}

function focusGain(room, participant, key, { throttle = true, broadcast = true } = {}) {
  const now = Date.now();
  if (participant && throttle) {
    const previous = participant.focusActions[key];
    if (previous !== undefined && now - previous < FOCUS_ACTION_COOLDOWN_MS) return false;
    participant.focusActions[key] = now;
  }
  const focus = room.focus;
  focus.state = applyFocusEvent(focus.state, key);
  focus.lastEvent = { key, byId: participant?.id || null, at: now };
  if (key === 'participate' || key === 'channel') {
    focus.contributions += 1;
    if (participant) participant.focusContributions += 1;
  }
  if (key === 'backchannel') {
    focus.collaborations += 1;
    if (participant) participant.focusCollaborations += 1;
  }
  if (key === 'drift') {
    focus.drifts += 1;
    focus.chain = 0;
    focus.lastContributorId = null;
  } else if (participant && ['participate', 'channel', 'backchannel'].includes(key)) {
    focus.chain = focus.lastContributorId && focus.lastContributorId !== participant.id ? focus.chain + 1 : 1;
    focus.lastContributorId = participant.id;
    focus.bestChain = Math.max(focus.bestChain, focus.chain);
  }
  if (broadcast) broadcastFocus(room);
  return true;
}

function alignmentCooldownMs(room) {
  const focus = room.focus;
  return focus.lastAlignmentStartedAt === null ? 0 :
    Math.max(0, focus.lastAlignmentStartedAt + ALIGNMENT_REPEAT_MS - focus.elapsedMs);
}

function startAlignment(room) {
  const focus = room.focus;
  const participantIds = [...room.participants.values()]
    .filter((p) => p.ws?.readyState === WebSocket.OPEN).map((p) => p.id);
  // A group alignment requires a group, and the captured roster cannot be
  // shrunk by leaving the room to manufacture a full alignment.
  if (focus.alignment || participantIds.length < 2 || alignmentCooldownMs(room) > 0) return false;
  focus.lastAlignmentStartedAt = focus.elapsedMs;
  focus.alignment = {
    id: rid('sync'),
    startedAt: Date.now(),
    endsAtElapsed: focus.elapsedMs + ALIGNMENT_WINDOW_MS,
    participantIds: new Set(participantIds),
    joinedIds: new Set()
  };
  focus.nextAlignmentAt = focus.elapsedMs + ALIGNMENT_REPEAT_MS;
  broadcastFocus(room);
  return true;
}

function finishAlignment(room, full) {
  const focus = room.focus;
  const alignment = focus.alignment;
  if (!alignment) return;
  focus.alignment = null;
  if (full) focus.syncsWon += 1;
  if (alignment.joinedIds.size) focusGain(room, null, full ? 'full_alignment' : 'partial_alignment');
  else broadcastFocus(room);
}

function stopFocusTimer(room) {
  if (room.focus.timer) clearInterval(room.focus.timer);
  room.focus.timer = null;
  room.focus.lastTickAt = null;
}

function updateFocusTimer(room) {
  const focus = room.focus;
  const live = [...room.participants.values()].some((p) => p.ws?.readyState === WebSocket.OPEN);
  if (!live) { stopFocusTimer(room); return; }
  if (focus.timer) return;
  focus.lastTickAt = Date.now();
  focus.timer = setInterval(() => {
    if (!rooms.has(room.id)) { stopFocusTimer(room); return; }
    const now = Date.now();
    const dtMs = Math.max(0, now - focus.lastTickAt);
    focus.lastTickAt = now;
    focus.elapsedMs += dtMs;
    focus.state = focusTick(focus.state, dtMs);
    if (focus.alignment && focus.elapsedMs >= focus.alignment.endsAtElapsed) finishAlignment(room, false);
    if (!focus.alignment && focus.elapsedMs >= focus.nextAlignmentAt) {
      focus.nextAlignmentAt = focus.elapsedMs + ALIGNMENT_REPEAT_MS;
      startAlignment(room);
    }
    broadcastFocus(room);
  }, FOCUS_INTERVAL_MS);
}

function sessionSummary(room, participant) {
  const focus = room.focus;
  const avgEnergy = focusAverage(focus.state.history.length ? focus.state.history : [focus.state.energy]);
  const progress = workspaceTaskProgress(room);
  const missionFrac = progress.itemsTotal ? progress.itemsCompleted / progress.itemsTotal : 0;
  const score = computeSessionScore({ avgEnergy, missionFrac, bestChain: focus.bestChain, syncsWon: focus.syncsWon, drifts: focus.drifts });
  return {
    sessionId: focus.sessionId,
    score,
    grade: gradeForScore(score),
    avgEnergy,
    bestChain: focus.bestChain,
    syncsWon: focus.syncsWon,
    drifts: focus.drifts,
    contributions: participant.focusContributions,
    collaborations: participant.focusCollaborations,
    durationMs: focus.elapsedMs,
    outcomes: decisions.decisionOutcomes(room),
    ...progress
  };
}

function endFocusSession(room) {
  const participants = [...room.participants.values()];
  stopFocusTimer(room);
  if (room.flushTimer) clearTimeout(room.flushTimer);
  releaseRoomRemoteControl(room);
  rooms.delete(room.id);
  for (const participant of participants) {
    send(participant.ws, { type: 'session:summary', summary: sessionSummary(room, participant) });
    send(participant.ws, { type: 'session:ended' });
    if (participant.ws) {
      participant.ws.__quorumRoomId = null;
      participant.ws.__quorumPeerId = null;
      participant.ws.close(1000, 'Meeting ended');
    }
  }
  room.participants.clear();
}

function releaseRoomRemoteControl(room) {
  if (activeRemoteRoomId === room.id) {
    remoteInput.releaseAll();
    activeRemoteRoomId = null;
  }
  room.remoteControlRequestId = null;
  room.remoteControlControllerId = null;
  room.lastRemoteInputAt = 0;
}

function remoteControlScreenAvailable(room) {
  return remoteInput.isSupported() && room.presentation.active && room.presentation.mode === 'screen' && room.presentation.presenterId === room.hostId && room.presentation.controlSurfaceAllowed;
}

/* ------------------------------------------------------------------ */
/* Message handling                                                    */
/* ------------------------------------------------------------------ */

function isHost(room, participant) {
  return participant && room.hostId === participant.id;
}

function dedupeName(room, name) {
  const names = new Set(
    [...room.participants.values()].map((p) => p.name.toLowerCase())
  );
  if (!names.has(name.toLowerCase())) return name;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${name} ${n}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
  return `${name} ${rid('').slice(1, 4)}`;
}

function handleJoin(ws, msg) {
  const code = roomCode(msg.roomId);
  const name = clean(msg.name, 42) || 'Guest';
  const room = ensureRoom(code);

  const existing = room.participants.get(ws.__quorumPeerId);
  if (existing?.ws === ws) {
    sendJoined(ws, room, existing, false, msg.minted);
    return;
  }

  // The token stays private to its participant; names and peer IDs are public.
  const token = typeof msg.resumeToken === 'string' ? msg.resumeToken : '';
  const resumable = token && [...room.participants.values()].find((p) =>
    p.resumeToken === token && (!p.disconnectedAt || Date.now() - p.disconnectedAt < RECONNECT_GRACE_MS)
  );
  if (resumable) {
    const oldSocket = resumable.ws;
    resumable.ws = ws;
    resumable.disconnectedAt = null;
    resumable.lastSeen = Date.now();
    ws.__quorumRoomId = code;
    ws.__quorumPeerId = resumable.id;
    if (oldSocket && oldSocket !== ws) oldSocket.terminate();
    updateFocusTimer(room);
    room.version += 1;
    sendJoined(ws, room, resumable, true, msg.minted);
    broadcast(room, {
      type: 'peer-rejoined',
      participant: serializeParticipant(resumable),
      room: snapshot(room)
    }, resumable.id);
    return;
  }

  if (room.participants.size >= MAX_PARTICIPANTS) {
    send(ws, {
      type: 'room-full',
      maxParticipants: MAX_PARTICIPANTS
    });
    return;
  }

  const isFirst = room.participants.size === 0;
  const peerId = rid('q');
  const participant = {
    id: peerId,
    ws,
    resumeToken: crypto.randomBytes(32).toString('hex'),
    disconnectedAt: null,
    name: dedupeName(room, name),
    role: isFirst ? 'host' : 'member',
    profile: cleanProfile(msg.profile),
    box: pickBoxSlot(room),
    groupId: null,
    micOn: true,
    camOn: true,
    handRaised: false,
    raisedAt: null,
    vote: null,
    gestureVotes: 0,
    joinedAt: Date.now(),
    lastSeen: Date.now(),
    focusActions: Object.create(null),
    focusContributions: 0,
    focusCollaborations: 0
  };

  room.participants.set(peerId, participant);
  if (isFirst) room.hostId = peerId;

  ws.__quorumRoomId = code;
  ws.__quorumPeerId = peerId;
  updateFocusTimer(room);

  room.version += 1;
  sendJoined(ws, room, participant, false, msg.minted);

  /*
   * Everyone else learns about the newcomer and initiates the WebRTC
   * offer (existing → new, the one-way pattern that avoids glare).
   */
  broadcast(
    room,
    {
      type: 'peer-joined',
      participant: serializeParticipant(participant),
      room: snapshot(room)
    },
    peerId
  );
}

function sendJoined(ws, room, participant, resumed, minted) {
  send(ws, {
    type: 'joined',
    selfId: participant.id,
    resumeToken: participant.resumeToken,
    resumed,
    reconnectGraceMs: RECONNECT_GRACE_MS,
    minted: !!minted,
    room: snapshot(room, participant.id)
  });
}

function disconnectParticipant(ws) {
  const code = ws.__quorumRoomId;
  const peerId = ws.__quorumPeerId;
  if (!code || !peerId) return;
  const room = rooms.get(code);
  const participant = room?.participants.get(peerId);
  // An old socket can close after its participant has already resumed.
  if (!participant || participant.ws !== ws) return;
  participant.ws = null;
  participant.disconnectedAt = Date.now();
  ws.__quorumRoomId = null;
  ws.__quorumPeerId = null;
  if (room.remoteControlControllerId === peerId || room.remoteControlRequestId === peerId || room.presentation.presenterId === peerId || room.hostId === peerId) {
    if (room.presentation.presenterId === peerId) room.presentation = { active: false, mode: 'slides', slideIndex: 0, presenterId: null, presenterName: '', controlSurfaceAllowed: false };
    releaseRoomRemoteControl(room);
  }
  updateFocusTimer(room);
  applyMutation(room, 'peer-disconnected');
}

function removeParticipant(room, peerId) {
  const participant = room.participants.get(peerId);
  if (!participant) return;
  if (participant.ws) {
    participant.ws.__quorumRoomId = null;
    participant.ws.__quorumPeerId = null;
  }
  room.participants.delete(peerId);
  const wasHost = room.hostId === peerId;
  if (room.remoteControlControllerId === peerId || room.remoteControlRequestId === peerId || room.presentation.presenterId === peerId) {
    if (room.presentation.presenterId === peerId) room.presentation = { active: false, mode: 'slides', slideIndex: 0, presenterId: null, presenterName: '', controlSurfaceAllowed: false };
    releaseRoomRemoteControl(room);
  }
  if (wasHost) {
    room.presentation = { active: false, mode: 'slides', slideIndex: 0, presenterId: null, presenterName: '', controlSurfaceAllowed: false };
    releaseRoomRemoteControl(room);
    const next = [...room.participants.values()].sort((a, b) =>
      Number(!!a.disconnectedAt) - Number(!!b.disconnectedAt) || a.joinedAt - b.joinedAt
    )[0];
    if (next) {
      next.role = 'host';
      next.vote = null;
      next.gestureVotes = 0;
      room.hostId = next.id;
    } else {
      room.hostId = null;
    }
  }
  if (!room.participants.size) {
    if (room.flushTimer) clearTimeout(room.flushTimer);
    stopFocusTimer(room);
    rooms.delete(room.id);
    return;
  }
  updateFocusTimer(room);
  room.version += 1;
  broadcast(room, { type: 'peer-left', peerId, wasHost, hostId: room.hostId, room: snapshot(room) });
}

function findGroup(room, groupId) {
  return room.groups.get(String(groupId || '')) || null;
}

function handleMessage(ws, msg) {
  const room = rooms.get(ws.__quorumRoomId);
  const sender = room?.participants.get(ws.__quorumPeerId);
  if (!room || !sender || sender.ws !== ws) {
    if (msg?.type === 'join') handleJoin(ws, msg);
    else if (msg?.type === 'ping') send(ws, { type: 'pong' });
    return;
  }

  sender.lastSeen = Date.now();

  if (typeof msg.type === 'string' && (msg.type.startsWith('decision:') || msg.type.startsWith('thinking:'))) {
    try {
      decisions.applyDecision(room, sender.id, msg);
      applyMutation(room, 'decisions');
    } catch (error) { send(ws, { type: 'error', code: 'DECISION_INVALID', message: error.message }); }
    return;
  }

  switch (msg.type) {
    case 'join': {
      sendJoined(ws, room, sender, false, msg.minted);
      return;
    }

    case 'leave': {
      send(ws, { type: 'session:summary', summary: sessionSummary(room, sender) });
      removeParticipant(room, sender.id);
      ws.close(1000, 'Left room');
      return;
    }

    case 'focus:participate':
    case 'focus:channel':
    case 'focus:backchannel': {
      focusGain(room, sender, msg.type.slice('focus:'.length));
      return;
    }

    case 'focus:sync-start':
    case 'focus:close':
    case 'focus:drift':
    case 'focus:end': {
      if (!isHost(room, sender)) {
        send(ws, { type: 'error', code: 'HOST_ONLY', message: 'Only the host can manage the meeting focus.' });
        return;
      }
      if (msg.type === 'focus:end') { endFocusSession(room); return; }
      if (msg.type === 'focus:sync-start') {
        if (!startAlignment(room)) {
          const remainingMs = alignmentCooldownMs(room);
          send(ws, {
            type: 'error',
            code: remainingMs > 0 ? 'ALIGNMENT_COOLDOWN' : 'ALIGNMENT_NEEDS_GROUP',
            message: remainingMs > 0 ? 'The next alignment will be ready shortly.' : 'Invite another participant to start a group alignment.',
            remainingMs
          });
        }
        return;
      }
      focusGain(room, sender, msg.type.slice('focus:'.length));
      return;
    }

    case 'focus:sync-join': {
      const alignment = room.focus.alignment;
      if (!alignment || !alignment.participantIds.has(sender.id) || alignment.joinedIds.has(sender.id)) return;
      alignment.joinedIds.add(sender.id);
      sender.focusCollaborations += 1;
      room.focus.collaborations += 1;
      if (alignment.joinedIds.size === alignment.participantIds.size) finishAlignment(room, true);
      else broadcastFocus(room);
      return;
    }

    case 'ping': {
      send(ws, { type: 'pong' });
      return;
    }

    case 'signal': {
      const target = room.participants.get(String(msg.targetId || ''));
      if (target) {
        send(target.ws, {
          type: 'signal',
          fromId: sender.id,
          signal: msg.signal
        });
      }
      return;
    }

    case 'presence': {
      const previousMic = sender.micOn;
      const previousCam = sender.camOn;
      if (typeof msg.micOn === 'boolean') sender.micOn = msg.micOn;
      if (typeof msg.camOn === 'boolean') sender.camOn = msg.camOn;
      if (previousMic !== sender.micOn || previousCam !== sender.camOn) applyMutation(room, 'presence');
      return;
    }

    case 'hand': {
      if (sender.handRaised === !!msg.raised) return;
      sender.handRaised = !!msg.raised;
      sender.raisedAt = sender.handRaised ? Date.now() : null;
      if (sender.handRaised) focusGain(room, sender, 'channel');
      applyMutation(room, 'hand');
      return;
    }

    case 'speaker:active': {
      for (const p of room.participants.values()) {
        if (p.id !== sender.id) send(p.ws, { ...msg, fromId: sender.id, fromName: sender.name });
      }
      return;
    }

    case 'presentation:state': {
      if (msg.active) {
        const mode = msg.mode === 'screen' ? 'screen' : 'slides';
        const canControl = isHost(room, sender) && mode === 'screen' && (msg.controlSurfaceAllowed === true || (room.presentation.presenterId === sender.id && room.presentation.controlSurfaceAllowed === true));
        room.presentation = {
          active: true,
          mode,
          slideIndex: Number.isInteger(msg.slideIndex) ? Math.max(0, Math.min(20, msg.slideIndex)) : 0,
          presenterId: sender.id,
          presenterName: sender.name,
          controlSurfaceAllowed: canControl
        };
        if (!canControl) releaseRoomRemoteControl(room);
      } else if (!msg.presenterId || room.presentation.presenterId === sender.id) {
        room.presentation = { active: false, mode: 'slides', slideIndex: 0, presenterId: null, presenterName: '', controlSurfaceAllowed: false };
        releaseRoomRemoteControl(room);
      }
      applyMutation(room, 'presentation');
      return;
    }

    case 'remote-control:request': {
      if (isHost(room, sender)) {
        send(ws, { type: 'error', message: 'The host does not need to request control.' });
        return;
      }
      if (!remoteControlScreenAvailable(room)) {
        send(ws, { type: 'error', message: 'The host must share the primary display from a Windows Quorum server first.' });
        return;
      }
      if (room.remoteControlControllerId || activeRemoteRoomId) {
        send(ws, { type: 'error', message: 'Remote control is already active on this computer.' });
        return;
      }
      if (room.remoteControlRequestId && room.remoteControlRequestId !== sender.id) {
        send(ws, { type: 'error', message: 'Another participant is already waiting for host approval.' });
        return;
      }
      room.remoteControlRequestId = sender.id;
      applyMutation(room, 'remote-control-request');
      return;
    }

    case 'remote-control:cancel': {
      if (room.remoteControlRequestId === sender.id) {
        room.remoteControlRequestId = null;
        applyMutation(room, 'remote-control-cancelled');
      } else if (room.remoteControlControllerId === sender.id) {
        releaseRoomRemoteControl(room);
        applyMutation(room, 'remote-control-released');
      }
      return;
    }

    case 'remote-control:grant': {
      if (!isHost(room, sender)) {
        send(ws, { type: 'error', code: 'HOST_ONLY', message: 'Only the host can approve remote control.' });
        return;
      }
      const peerId = String(msg.peerId || '');
      if (!remoteControlScreenAvailable(room) || peerId !== room.remoteControlRequestId || !room.participants.has(peerId)) {
        send(ws, { type: 'error', message: 'That control request is no longer available.' });
        return;
      }
      if (activeRemoteRoomId && activeRemoteRoomId !== room.id) {
        send(ws, { type: 'error', message: 'Another Quorum room is already controlling this computer.' });
        return;
      }
      const requestedPeerId = peerId;
      remoteInput.start().then((ready) => {
        if (!ready) {
          send(ws, { type: 'error', message: 'The Windows remote input helper could not start.' });
          return;
        }
        if (rooms.get(room.id) !== room || !isHost(room, sender) || room.remoteControlRequestId !== requestedPeerId || !remoteControlScreenAvailable(room)) {
          remoteInput.releaseAll();
          return;
        }
        room.remoteControlControllerId = requestedPeerId;
        room.remoteControlRequestId = null;
        room.lastRemoteInputAt = 0;
        activeRemoteRoomId = room.id;
        applyMutation(room, 'remote-control-granted');
      }).catch(() => send(ws, { type: 'error', message: 'The Windows remote input helper could not start.' }));
      return;
    }

    case 'remote-control:deny': {
      if (!isHost(room, sender)) {
        send(ws, { type: 'error', code: 'HOST_ONLY', message: 'Only the host can decline a control request.' });
        return;
      }
      if (String(msg.peerId || '') === room.remoteControlRequestId) {
        room.remoteControlRequestId = null;
        applyMutation(room, 'remote-control-declined');
      }
      return;
    }

    case 'remote-control:revoke': {
      if (!isHost(room, sender)) {
        send(ws, { type: 'error', code: 'HOST_ONLY', message: 'Only the host can revoke remote control.' });
        return;
      }
      releaseRoomRemoteControl(room);
      applyMutation(room, 'remote-control-revoked');
      return;
    }

    case 'remote-control:input': {
      if (room.remoteControlControllerId !== sender.id || activeRemoteRoomId !== room.id || !remoteControlScreenAvailable(room)) return;
      const now = Date.now();
      if (now - room.lastRemoteInputAt < 7) return;
      room.lastRemoteInputAt = now;
      if (!remoteInput.sendInput(msg.input)) {
        releaseRoomRemoteControl(room);
        applyMutation(room, 'remote-control-failed');
      }
      return;
    }

    case 'vote': {
      if (!room.ballot.open) {
        send(ws, { type: 'error', message: 'No ballot is open right now.' });
        return;
      }
      if (isHost(room, sender)) {
        send(ws, { type: 'error', code: 'HOST_CANNOT_VOTE', message: 'The host facilitates this ballot; the groups vote.' });
        return;
      }
      if (!sender.groupId) {
        send(ws, {
          type: 'error',
          message: 'The host has not placed you in a group yet.'
        });
        return;
      }
      const choice = msg.choice === null || msg.choice === 'none' ? null : String(msg.choice);
      if (choice !== null && !VOTE_CHOICES.has(choice)) return;
      const changed = sender.vote !== choice;
      if (!changed) return;
      sender.vote = choice;
      if (choice) focusGain(room, sender, 'backchannel');
      if (choice && msg.source === 'gesture' && changed) {
        sender.gestureVotes = (sender.gestureVotes || 0) + 1;
      }
      applyMutation(room, 'vote');
      return;
    }

    case 'workspace:create': {
      if (!WORKSPACE_KINDS.has(msg.kind)) {
        send(ws, { type: 'error', code: 'WORKSPACE_INVALID', message: 'Choose a supported workspace screen.' });
        return;
      }
      if (room.tools.size >= MAX_WORKSPACE_TOOLS) {
        send(ws, { type: 'error', code: 'WORKSPACE_LIMIT', message: `A room supports up to ${MAX_WORKSPACE_TOOLS} tool screens.` });
        return;
      }
      try {
        const defaults = { notes: 'Shared notes', board: 'Whiteboard', tasks: 'Team tasks', timer: 'Focus timer', embed: 'Tool channel' };
        const url = msg.kind === 'embed' ? workspaceUrl(msg.url) : null;
        if (msg.kind === 'embed' && !url) throw new Error('Use an HTTPS tool URL without credentials. Local development URLs may use HTTP.');
        const tool = {
          id: rid('tool'), kind: msg.kind, title: clean(msg.title, 80) || defaults[msg.kind],
          x: worldPosition(msg.x, 0.55), y: worldPosition(msg.y, 0.18),
          w: msg.kind === 'embed' ? 0.4 : msg.kind === 'board' ? 0.35 : 0.275,
          h: msg.kind === 'embed' ? 0.42 : msg.kind === 'board' ? 0.4 : 0.34,
          ...(url ? { url } : {}),
          data: typeof msg.data === 'undefined' ? defaultWorkspaceData(msg.kind) : workspaceData(msg.kind, msg.data),
          createdBy: sender.id, version: 1
        };
        if (!workspaceWithinBudget(room, tool)) {
          send(ws, { type: 'error', code: 'WORKSPACE_LIMIT', message: 'The workspace is full. Clear unused screen content first.' });
          return;
        }
        room.tools.set(tool.id, tool);
        recordTaskCompletions(room, sender, tool);
        applyMutation(room, 'workspace');
      } catch (error) {
        send(ws, { type: 'error', code: 'WORKSPACE_INVALID', message: error.message });
      }
      return;
    }

    case 'workspace:update':
    case 'workspace:delete': {
      const id = String(msg.id || '');
      const tool = room.tools.get(id);
      if (!tool) {
        send(ws, { type: 'error', code: 'WORKSPACE_MISSING', id, message: 'This screen has already been removed.' });
        return;
      }
      // Documents must be edited against the version actually shown to avoid
      // silently overwriting another participant's concurrent work.
      if ((typeof msg.data !== 'undefined' || typeof msg.baseVersion !== 'undefined') && msg.baseVersion !== tool.version) {
        send(ws, { type: 'error', code: 'WORKSPACE_CONFLICT', id, message: 'Another participant updated this screen. Your draft is preserved; review the latest version before saving.', tool, room: snapshot(room, sender.id) });
        return;
      }
      if (msg.type === 'workspace:delete') {
        room.tools.delete(id);
        applyMutation(room, 'workspace');
        return;
      }
      try {
        const next = { ...tool };
        if (typeof msg.title !== 'undefined') {
          if (typeof msg.title !== 'string' || !clean(msg.title, 80)) throw new Error('Give this screen a title.');
          next.title = clean(msg.title, 80);
        }
        for (const key of ['x', 'y', 'w', 'h']) {
          if (typeof msg[key] === 'undefined') continue;
          const min = key === 'w' ? 0.18 : key === 'h' ? 0.15 : -100;
          const max = key === 'w' || key === 'h' ? 1.5 : 100;
          if (!validNumber(msg[key], min, max)) throw new Error('The screen position or size is outside the workspace limits.');
          next[key] = msg[key];
        }
        if (typeof msg.url !== 'undefined') {
          if (tool.kind !== 'embed' || !(next.url = workspaceUrl(msg.url))) throw new Error('Use an HTTPS tool URL without credentials.');
        }
        if (typeof msg.data !== 'undefined') next.data = workspaceData(tool.kind, msg.data);
        if (!workspaceWithinBudget(room, next)) {
          send(ws, { type: 'error', code: 'WORKSPACE_LIMIT', id, message: 'The workspace is full. Clear unused screen content first.' });
          return;
        }
        next.version += 1;
        room.tools.set(id, next);
        recordTaskCompletions(room, sender, next, tool);
        applyMutation(room, 'workspace');
      } catch (error) {
        send(ws, { type: 'error', code: 'WORKSPACE_INVALID', id, message: error.message });
      }
      return;
    }

    case 'participant:move':
    case 'host:move': {
      const peerId = String(msg.peerId || sender.id);
      if (!isHost(room, sender) && peerId !== sender.id) {
        send(ws, { type: 'error', code: 'HOST_ONLY', message: 'Only the host can move another participant.' });
        return;
      }
      const target = room.participants.get(peerId);
      if (!target) return;
      target.box = { x: worldPosition(msg.x, target.box.x), y: worldPosition(msg.y, target.box.y) };
      if (isHost(room, sender) && typeof msg.groupId !== 'undefined') {
        const requested = msg.groupId === null ? null : findGroup(room, msg.groupId)?.id || null;
        target.groupId = requested;
      }
      broadcastLayout(room);
      return;
    }

    case 'host:group-create': {
      if (!isHost(room, sender)) {
        send(ws, { type: 'error', code: 'HOST_ONLY', message: 'Only the host can create groups.' });
        return;
      }
      if (room.groups.size >= MAX_GROUPS) {
        send(ws, { type: 'error', message: `Up to ${MAX_GROUPS} groups fit on the stage.` });
        return;
      }
      room.groupSeq += 1;
      const anchor = pickGroupSlot(room);
      const group = {
        id: rid('g'),
        name: clean(msg.name, 32) || `Group ${room.groupSeq}`,
        color: GROUP_COLORS[(room.groupSeq - 1) % GROUP_COLORS.length],
        x: worldPosition(msg.x, anchor.x),
        y: worldPosition(msg.y, anchor.y),
        w: GROUP_SIZE.w,
        h: GROUP_SIZE.h,
        createdAt: Date.now()
      };
      room.groups.set(group.id, group);
      applyMutation(room, 'group-created');
      return;
    }

    case 'host:group-update': {
      if (!isHost(room, sender)) {
        send(ws, { type: 'error', code: 'HOST_ONLY', message: 'Only the host can change groups.' });
        return;
      }
      const group = findGroup(room, msg.groupId);
      if (!group) return;

      let moved = false;
      if (typeof msg.x !== 'undefined' || typeof msg.y !== 'undefined') {
        const nx = worldPosition(msg.x, group.x);
        const ny = worldPosition(msg.y, group.y);
        const dx = nx - group.x;
        const dy = ny - group.y;
        group.x = nx;
        group.y = ny;
        moved = Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6;

        if (moved) {
          /* The group carries its members so nobody is left floating outside. */
          for (const p of room.participants.values()) {
            if (p.groupId === group.id) {
              p.box = { x: worldPosition(p.box.x + dx), y: worldPosition(p.box.y + dy) };
            }
          }
        }
      }
      if (typeof msg.name === 'string' && clean(msg.name, 32)) {
        group.name = clean(msg.name, 32);
      }

      if (moved) broadcastLayout(room);
      else applyMutation(room, 'group-updated');
      return;
    }

    case 'host:group-delete': {
      if (!isHost(room, sender)) {
        send(ws, { type: 'error', code: 'HOST_ONLY', message: 'Only the host can delete groups.' });
        return;
      }
      const group = findGroup(room, msg.groupId);
      if (!group) return;
      room.groups.delete(group.id);
      for (const p of room.participants.values()) {
        if (p.groupId === group.id) p.groupId = null;
      }
      applyMutation(room, 'group-deleted');
      return;
    }

    case 'host:motion': {
      if (!isHost(room, sender)) {
        send(ws, { type: 'error', code: 'HOST_ONLY', message: 'Only the host can set the motion.' });
        return;
      }
      const motion = clean(msg.text, 240);
      if (motion === room.motion) return;
      room.motion = motion;
      if (motion) focusGain(room, sender, 'participate');
      applyMutation(room, 'motion');
      return;
    }

    case 'host:vote-open': {
      if (!isHost(room, sender)) {
        send(ws, { type: 'error', code: 'HOST_ONLY', message: 'Only the host can open a ballot.' });
        return;
      }
      const seconds = Number(msg.seconds);
      const duration =
        Number.isFinite(seconds) && seconds >= 10 && seconds <= 600
          ? seconds * 1000
          : null;
      room.ballot = {
        open: true,
        openedAt: Date.now(),
        closesAt: duration ? Date.now() + duration : null
      };
      for (const p of room.participants.values()) {
        p.vote = null;
        p.gestureVotes = 0;
      }
      applyMutation(room, 'vote-open');
      return;
    }

    case 'host:vote-close': {
      if (!isHost(room, sender)) {
        send(ws, { type: 'error', code: 'HOST_ONLY', message: 'Only the host can close a ballot.' });
        return;
      }
      if (!room.ballot.open) return;
      room.ballot = { open: false, openedAt: room.ballot.openedAt, closesAt: null };
      focusGain(room, sender, 'close');
      applyMutation(room, 'vote-closed');
      return;
    }

    case 'host:reset-hands': {
      if (!isHost(room, sender)) {
        send(ws, { type: 'error', code: 'HOST_ONLY', message: 'Only the host can reset hands.' });
        return;
      }
      for (const p of room.participants.values()) {
        p.handRaised = false;
        p.raisedAt = null;
      }
      applyMutation(room, 'hands-reset');
      return;
    }

    default:
      return;
  }
}

/* Ballot timers + stale connection sweep. */
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.ballot.open && room.ballot.closesAt && now >= room.ballot.closesAt) {
      room.ballot = { open: false, openedAt: room.ballot.openedAt, closesAt: null };
      focusGain(room, null, 'close');
      applyMutation(room, 'vote-closed');
    }
    for (const p of [...room.participants.values()]) {
      if (p.disconnectedAt && now - p.disconnectedAt >= RECONNECT_GRACE_MS) removeParticipant(room, p.id);
    }
  }
}, SWEEP_MS);

/* ------------------------------------------------------------------ */
/* Static file hosting (Velos site + Quorum Space)                     */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch (_) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  const requestUrl = new URL(req.url, 'http://x');
  const staticSegments = urlPath.replace(/\\/g, '/').split('/').filter(Boolean).map((segment) => segment.toLowerCase());
  const privateFiles = new Set(['server.js', 'remote-input.js', 'rtc-config.js', 'render.yaml', 'vercel.json']);
  const privateDirectories = new Set(['lib', 'scripts']);
  if (staticSegments.some((segment) => segment.startsWith('.') || segment === 'node_modules') ||
      privateDirectories.has(staticSegments[0]) ||
      (staticSegments.length === 1 && privateFiles.has(staticSegments[0]))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (urlPath === '/quorum') {
    res.writeHead(308, { Location: `/quorum/${requestUrl.search}` });
    res.end();
    return;
  }
  if (urlPath === '/app') {
    res.writeHead(308, { Location: `/app/${requestUrl.search}` });
    res.end();
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    let target = filePath;
    if (err || !stat.isFile()) {
      /* Room-code links canonicalize to Quorum's directory so relative assets work. */
      if (path.extname(urlPath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const code = urlPath.replace(/^\/+|\/+$/g, '');
      const query = new URLSearchParams(requestUrl.search);
      if (code && code !== 'quorum' && code !== 'app') query.set('room', code);
      res.writeHead(302, { Location: `/quorum/${query.size ? `?${query}` : ''}` });
      res.end();
      return;
    }
    fs.readFile(target, (readErr, data) => {
      if (readErr) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(data);
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.headers.upgrade?.toLowerCase().includes('websocket')) return; /* handled by ws */
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'GET' && pathname === '/quorum-config') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(await publicRtcConfig()));
    return;
  }
  if (req.method === 'GET' && pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ status: 'ok', service: 'velos-quorum' }));
    return;
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ server, path: WS_PATH, maxPayload: 512 * 1024 });

wss.on('connection', (ws) => {
  ws.__quorumLastSeen = Date.now();
  // Browser WebSocket implementations answer control pings even when their JS
  // timers are throttled in a background tab.
  ws.on('pong', () => {
    ws.__quorumLastSeen = Date.now();
  });
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch (_) {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    ws.__quorumLastSeen = Date.now();
    try {
      handleMessage(ws, msg);
    } catch (err) {
      console.error('quorum-space message error:', err);
      send(ws, { type: 'error', message: 'Server could not process that action.' });
    }
  });
  ws.on('close', () => disconnectParticipant(ws));
  ws.on('error', () => {
    try {
      ws.terminate();
    } catch (_) {}
  });
});

const heartbeatTimer = setInterval(() => {
  const now = Date.now();
  for (const ws of wss.clients) {
    if (now - ws.__quorumLastSeen > CONNECTION_TIMEOUT_MS) {
      ws.terminate();
      continue;
    }
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.ping(); } catch (_) { ws.terminate(); }
    }
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeatTimer));

wss.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') console.error('WebSocket server error:', err.message);
});

process.on('exit', () => remoteInput.stop());

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('Port ' + PORT + ' is already in use. Stop the other server or start Quorum with a different port, for example: set PORT=8898 && npm start');
    process.exit(1);
    return;
  }
  console.error('Quorum server failed to start:', err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const port = server.address().port;
  console.log('──────────────────────────────────────────────');
  console.log('  Velos + Quorum — merged platform');
  console.log(`  Site:        http://localhost:${port}`);
  console.log(`  Quorum Space http://localhost:${port}/quorum/`);
  console.log(`  Signaling:   ws://localhost:${port}${WS_PATH}`);
  console.log(`  Rooms:       1 host + ${MAX_PARTICIPANTS - 1} members per room`);
  console.log('──────────────────────────────────────────────');
});
