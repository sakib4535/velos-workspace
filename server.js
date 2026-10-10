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
 * Only the host can move boxes, manage groups and run ballots.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const remoteInput = require('./remote-input');

const PORT = Number(process.env.PORT || process.env.QUORUM_PORT || 8788);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const WS_PATH = '/quorum-space';
const MAX_PARTICIPANTS = 16;
const MAX_GROUPS = 8;
const SWEEP_MS = 5000;
const LAST_SEEN_TIMEOUT_MS = 45000;

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

const clamp01 = (value, fallback = 0.5) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(0.98, Math.max(0.02, num));
};

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
      groupSeq: 0,
      motion: '',
      ballot: { open: false, openedAt: null, closesAt: null },
      presentation: { active: false, mode: 'slides', slideIndex: 0, presenterId: null, presenterName: '', controlSurfaceAllowed: false },
      remoteControlRequestId: null,
      remoteControlControllerId: null,
      lastRemoteInputAt: 0,
      flushTimer: null
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
    joinedAt: p.joinedAt
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

function snapshot(room) {
  return {
    id: room.id,
    version: room.version,
    hostId: room.hostId,
    createdAt: room.createdAt,
    participants: [...room.participants.values()].map(serializeParticipant),
    groups: [...room.groups.values()].map(serializeGroup),
    motion: room.motion,
    ballot: { ...room.ballot },
    presentation: { ...room.presentation },
    remoteControl: remoteControlSnapshot(room),
    tally: tallyVotes(room)
  };
}
function send(ws, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(data));
  } catch (_) { /* socket died mid-write; the close handler cleans up */ }
}

function broadcast(room, data, exceptId = null) {
  for (const p of room.participants.values()) {
    if (p.id !== exceptId) send(p.ws, data);
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
    name: dedupeName(room, name),
    role: isFirst ? 'host' : 'member',
    box: pickBoxSlot(room),
    groupId: null,
    micOn: true,
    camOn: true,
    handRaised: false,
    raisedAt: null,
    vote: null,
    gestureVotes: 0,
    joinedAt: Date.now(),
    lastSeen: Date.now()
  };

  room.participants.set(peerId, participant);
  if (isFirst) room.hostId = peerId;

  ws.__quorumRoomId = code;
  ws.__quorumPeerId = peerId;

  send(ws, {
    type: 'joined',
    selfId: peerId,
    minted: !!msg.minted,
    room: snapshot(room)
  });

  /*
   * Everyone else learns about the newcomer and initiates the WebRTC
   * offer (existing → new, the one-way pattern that avoids glare).
   */
  room.version += 1;
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

function removeParticipant(ws) {
  const code = ws.__quorumRoomId;
  const peerId = ws.__quorumPeerId;
  if (!code || !peerId) return;
  const room = rooms.get(code);
  if (!room) return;
  room.participants.delete(peerId);
  const wasHost = room.hostId === peerId;
  if (room.remoteControlControllerId === peerId || room.remoteControlRequestId === peerId || room.presentation.presenterId === peerId) {
    if (room.presentation.presenterId === peerId) room.presentation = { active: false, mode: 'slides', slideIndex: 0, presenterId: null, presenterName: '', controlSurfaceAllowed: false };
    releaseRoomRemoteControl(room);
  }
  if (wasHost) {
    room.presentation = { active: false, mode: 'slides', slideIndex: 0, presenterId: null, presenterName: '', controlSurfaceAllowed: false };
    releaseRoomRemoteControl(room);
    const next = [...room.participants.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (next) {
      next.role = 'host';
      next.vote = null;
      next.gestureVotes = 0;
      room.hostId = next.id;
    } else {
      room.hostId = null;
    }
  }
  ws.__quorumRoomId = null;
  ws.__quorumPeerId = null;
  if (!room.participants.size) {
    if (room.flushTimer) clearTimeout(room.flushTimer);
    rooms.delete(code);
    return;
  }
  room.version += 1;
  broadcast(room, { type: 'peer-left', peerId, wasHost, hostId: room.hostId, room: snapshot(room) });
}

function findGroup(room, groupId) {
  return room.groups.get(String(groupId || '')) || null;
}

function handleMessage(ws, msg) {
  const room = rooms.get(ws.__quorumRoomId);
  const sender = room?.participants.get(ws.__quorumPeerId);
  if (!room || !sender) {
    if (msg?.type === 'join') handleJoin(ws, msg);
    else if (msg?.type === 'ping') send(ws, { type: 'pong' });
    return;
  }

  sender.lastSeen = Date.now();

  switch (msg.type) {
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
      if (typeof msg.micOn === 'boolean') sender.micOn = msg.micOn;
      if (typeof msg.camOn === 'boolean') sender.camOn = msg.camOn;
      applyMutation(room, 'presence');
      return;
    }

    case 'hand': {
      sender.handRaised = !!msg.raised;
      sender.raisedAt = sender.handRaised ? Date.now() : null;
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
      sender.vote = choice;
      if (choice && msg.source === 'gesture' && changed) {
        sender.gestureVotes = (sender.gestureVotes || 0) + 1;
      }
      applyMutation(room, 'vote');
      return;
    }

    case 'host:move': {
      if (!isHost(room, sender)) {
        send(ws, { type: 'error', code: 'HOST_ONLY', message: 'Only the host can move boxes.' });
        return;
      }
      const target = room.participants.get(String(msg.peerId || ''));
      if (!target) return;
      target.box = { x: clamp01(msg.x), y: clamp01(msg.y) };
      if (typeof msg.groupId !== 'undefined') {
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
        x: clamp01(anchor.x),
        y: clamp01(anchor.y),
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
        const nx = clamp01(msg.x, group.x);
        const ny = clamp01(msg.y, group.y);
        const dx = nx - group.x;
        const dy = ny - group.y;
        group.x = nx;
        group.y = ny;
        moved = Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6;

        if (moved) {
          /* The group carries its members so nobody is left floating outside. */
          for (const p of room.participants.values()) {
            if (p.groupId === group.id) {
              p.box = { x: clamp01(p.box.x + dx), y: clamp01(p.box.y + dy) };
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
      room.motion = clean(msg.text, 240);
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
      room.ballot = { open: false, openedAt: room.ballot.openedAt, closesAt: null };
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
      applyMutation(room, 'vote-closed');
    }
    for (const p of [...room.participants.values()]) {
      if (now - p.lastSeen > LAST_SEEN_TIMEOUT_MS) {
        try {
          p.ws.terminate();
        } catch (_) {}
        removeParticipant(p.ws);
      }
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

const server = http.createServer((req, res) => {
  if (req.headers.upgrade?.toLowerCase().includes('websocket')) return; /* handled by ws */
  if (req.method === 'GET' && new URL(req.url, 'http://localhost').pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ status: 'ok', service: 'velos-quorum' }));
    return;
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ server, path: WS_PATH, maxPayload: 512 * 1024 });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch (_) {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    try {
      handleMessage(ws, msg);
    } catch (err) {
      console.error('quorum-space message error:', err);
      send(ws, { type: 'error', message: 'Server could not process that action.' });
    }
  });
  ws.on('close', () => removeParticipant(ws));
  ws.on('error', () => {
    try {
      ws.terminate();
    } catch (_) {}
  });
});

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
  console.log('──────────────────────────────────────────────');
  console.log('  Velos + Quorum — merged platform');
  console.log(`  Site:        http://localhost:${PORT}`);
  console.log(`  Quorum Space http://localhost:${PORT}/quorum/`);
  console.log(`  Signaling:   ws://localhost:${PORT}${WS_PATH}`);
  console.log(`  Rooms:       1 host + ${MAX_PARTICIPANTS - 1} members per room`);
  console.log('──────────────────────────────────────────────');
});
