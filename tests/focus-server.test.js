'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { before, after, test } = require('node:test');
const { WebSocket } = require('ws');
const { computeSessionScore, gradeForScore } = require('../lib/quorum-core.cjs');

let serverProcess;
let wsUrl;
const sockets = new Set();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  // Advance only the child server's clock to exercise scheduled windows without
  // changing production timings or making this regression test wait 45 seconds.
  const bootstrap = `
    let clockOffset = 0;
    const actualNow = Date.now;
    Date.now = () => actualNow() + clockOffset;
    process.on('message', (message) => {
      if (message.type !== 'test:advance-clock') return;
      clockOffset += message.ms;
      process.send({ type: 'test:clock-advanced' });
    });
    require(process.argv[1]);
  `;
  serverProcess = spawn(process.execPath, ['-e', bootstrap, path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', QUORUM_RECONNECT_GRACE_MS: '3000' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 8000);
    serverProcess.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const match = output.match(/Site:\s+http:\/\/localhost:(\d+)/);
      if (!match) return;
      wsUrl = `ws://127.0.0.1:${match[1]}/quorum-space`;
      clearTimeout(timer);
      resolve();
    });
    serverProcess.stderr.on('data', (chunk) => { output += chunk.toString(); });
    serverProcess.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited (${code}): ${output}`)); });
    serverProcess.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
});

async function advanceServerClock(ms) {
  const advanced = once(serverProcess, 'message');
  serverProcess.send({ type: 'test:advance-clock', ms });
  await advanced;
}

after(async () => {
  for (const socket of sockets) socket.terminate();
  if (serverProcess?.exitCode === null) {
    const exited = once(serverProcess, 'exit');
    serverProcess.kill();
    await exited;
  }
});

async function connect() {
  const ws = new WebSocket(wsUrl);
  const messages = [];
  const waiting = new Set();
  sockets.add(ws);
  ws.on('message', (raw) => {
    const message = JSON.parse(raw);
    for (const waiter of waiting) {
      if (!waiter.predicate(message)) continue;
      waiting.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    messages.push(message);
  });
  ws.on('close', () => sockets.delete(ws));
  ws.on('error', () => {});
  await once(ws, 'open');
  return {
    ws,
    send(message) { ws.send(JSON.stringify(message)); },
    next(predicate, timeout = 3000) {
      if (typeof predicate === 'string') {
        const type = predicate;
        predicate = (message) => message.type === type;
      }
      const index = messages.findIndex(predicate);
      if (index !== -1) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => { waiting.delete(waiter); reject(new Error('Timed out waiting for focus message')); }, timeout);
        waiting.add(waiter);
      });
    }
  };
}

async function join(client, roomId, name, extra = {}) {
  client.send({ type: 'join', roomId, name, ...extra });
  return client.next('joined');
}

async function currentRoom(client) {
  client.send({ type: 'join' });
  return (await client.next('joined')).room;
}

const focusEvent = (key, extra = () => true) => (message) =>
  message.type === 'focus:state' && message.focus.lastEvent?.key === key && extra(message.focus);

test('participants share one sampled meter; gains are validated and action spam is throttled', async () => {
  const host = await connect();
  const member = await connect();
  const initial = await join(host, 'focus-shared', 'Host');
  const joined = await join(member, 'focus-shared', 'Member');
  assert.equal(initial.room.focus.energy, 62);
  assert.equal(initial.room.focus.sessionId, joined.room.focus.sessionId);
  const tick = await host.next((message) => message.type === 'focus:state' && message.focus.elapsedMs >= 500);
  assert.ok(tick.focus.energy < 62 && tick.focus.energy > 60);
  assert.ok(tick.focus.history.length > 0);

  host.send({ type: 'focus:participate', delta: 1000 });
  const contribution = await host.next(focusEvent('participate', (focus) => focus.contributions === 1));
  const shared = await member.next(focusEvent('participate', (focus) => focus.contributions === 1));
  assert.equal(shared.focus.energy, contribution.focus.energy);
  assert.ok(Math.abs(contribution.focus.energy - tick.focus.energy - 6) < 0.1);
  host.send({ type: 'focus:participate' });
  host.send({ type: 'focus:event', key: 'full_alignment', delta: 100 });
  host.send({ type: 'presence', micOn: false });
  host.send({ type: 'speaker:active' });
  assert.equal((await currentRoom(host)).focus.contributions, 1);
  assert.equal((await currentRoom(host)).focus.syncsWon, 0);
});

test('existing motion, hand raise, vote and ballot completion map to focus exactly once', async () => {
  const host = await connect();
  const member = await connect();
  await join(host, 'focus-native-actions', 'Host');
  const joined = await join(member, 'focus-native-actions', 'Member');
  host.send({ type: 'host:motion', text: 'Choose the next project milestone' });
  const motion = await host.next(focusEvent('participate'));
  assert.equal(motion.focus.contributions, 1);
  host.send({ type: 'host:motion', text: 'Choose the next project milestone' });
  member.send({ type: 'hand', raised: true });
  const hand = await member.next(focusEvent('channel'));
  assert.equal(hand.focus.contributions, 2);
  member.send({ type: 'hand', raised: true });
  host.send({ type: 'host:group-create', name: 'Team' });
  const groupState = await host.next((message) => message.type === 'state' && message.reason === 'group-created');
  host.send({ type: 'host:move', peerId: joined.selfId, x: 0.5, y: 0.5, groupId: groupState.room.groups[0].id });
  host.send({ type: 'host:vote-open' });
  await member.next((message) => message.type === 'state' && message.reason === 'vote-open');
  member.send({ type: 'vote', choice: 'yes' });
  const vote = await member.next(focusEvent('backchannel'));
  assert.equal(vote.focus.collaborations, 1);
  member.send({ type: 'vote', choice: 'yes' });
  host.send({ type: 'host:vote-close' });
  await host.next(focusEvent('close'));
  const beforeRepeat = (await currentRoom(host)).focus;
  host.send({ type: 'host:vote-close' });
  const afterRepeat = (await currentRoom(host)).focus;
  assert.equal(afterRepeat.energy, beforeRepeat.energy);
  assert.equal(afterRepeat.contributions, 2);
  assert.equal(afterRepeat.collaborations, 1);
});

test('focus state and personal contributions survive resume, and decay pauses while everyone is offline', async () => {
  const original = await connect();
  const joined = await join(original, 'focus-resume', 'Host');
  original.send({ type: 'focus:participate' });
  await original.next(focusEvent('participate'));
  const tick = await original.next((message) => message.type === 'focus:state' && message.focus.elapsedMs >= 500);
  const closed = once(original.ws, 'close');
  original.ws.terminate();
  await closed;
  await delay(800);
  const replacement = await connect();
  const resumed = await join(replacement, 'focus-resume', 'Host', { resumeToken: joined.resumeToken });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.room.focus.sessionId, joined.room.focus.sessionId);
  assert.equal(resumed.room.focus.elapsedMs, tick.focus.elapsedMs);
  assert.equal(resumed.room.focus.energy, tick.focus.energy);
  assert.equal(resumed.room.focus.contributions, 1);
  replacement.send({ type: 'leave' });
  const summary = (await replacement.next('session:summary')).summary;
  assert.equal(summary.contributions, 1);
  const fresh = await connect();
  const restarted = await join(fresh, 'focus-resume', 'Host');
  assert.notEqual(restarted.room.focus.sessionId, joined.room.focus.sessionId);
  assert.equal(restarted.room.focus.energy, 62);
});

test('alignment needs the captured group roster, cannot be spammed, and awards one collaboration per person', async () => {
  const host = await connect();
  const member = await connect();
  const hostJoined = await join(host, 'focus-alignment', 'Host');
  const memberJoined = await join(member, 'focus-alignment', 'Member');
  assert.equal(memberJoined.room.focus.canStartAlignment, true);
  assert.equal(memberJoined.room.focus.nextAlignmentInMs, 0);
  member.send({ type: 'focus:sync-start' });
  assert.equal((await member.next('error')).code, 'HOST_ONLY');
  host.send({ type: 'focus:sync-start' });
  const window = await host.next((message) => message.type === 'focus:state' && message.focus.alignment);
  assert.equal(window.focus.canStartAlignment, false);
  assert.equal(window.focus.nextAlignmentInMs, 75000);
  assert.deepEqual(new Set(window.focus.alignment.participantIds), new Set([hostJoined.selfId, memberJoined.selfId]));
  member.send({ type: 'focus:sync-join' });
  member.send({ type: 'focus:sync-join' });
  await host.next((message) => message.type === 'focus:state' && message.focus.alignment?.joinedIds.length === 1);
  host.send({ type: 'focus:sync-join' });
  const full = await host.next(focusEvent('full_alignment'));
  assert.equal(full.focus.syncsWon, 1);
  assert.equal(full.focus.collaborations, 2);
  assert.equal(full.focus.alignment, null);
  assert.equal(full.focus.canStartAlignment, false);
  assert.ok(full.focus.nextAlignmentInMs > 74000 && full.focus.nextAlignmentInMs <= 75000);
  assert.ok(Math.abs(full.focus.energy - window.focus.energy - 16) < 0.1);
  host.send({ type: 'focus:sync-start' });
  const cooldownError = await host.next('error');
  assert.equal(cooldownError.code, 'ALIGNMENT_COOLDOWN');
  assert.ok(cooldownError.remainingMs > 74000);
  host.send({ type: 'focus:sync-join' });
  assert.equal((await currentRoom(host)).focus.syncsWon, 1);
  assert.equal((await currentRoom(host)).focus.alignment, null);
});

test('a partially joined alignment earns six energy when its ten-second window expires', async () => {
  const host = await connect();
  const member = await connect();
  await join(host, 'focus-partial', 'Host');
  await join(member, 'focus-partial', 'Member');
  host.send({ type: 'focus:sync-start' });
  await host.next((message) => message.type === 'focus:state' && message.focus.alignment);
  member.send({ type: 'focus:sync-join' });
  const partial = await host.next(focusEvent('partial_alignment'), 12000);
  assert.equal(partial.focus.alignment, null);
  assert.equal(partial.focus.syncsWon, 0);
  assert.equal(partial.focus.collaborations, 1);
  assert.ok(partial.focus.energy > 57 && partial.focus.energy < 60);
});

test('only the host ends the meeting; final summaries use shared score and personal activity', async () => {
  const host = await connect();
  const member = await connect();
  await join(host, 'focus-end', 'Host');
  await join(member, 'focus-end', 'Member');
  host.send({ type: 'focus:participate' });
  await host.next(focusEvent('participate'));
  member.send({ type: 'focus:backchannel' });
  await host.next(focusEvent('backchannel'));
  member.send({ type: 'focus:drift' });
  assert.equal((await member.next('error')).code, 'HOST_ONLY');
  member.send({ type: 'focus:end' });
  assert.equal((await member.next('error')).code, 'HOST_ONLY');
  host.send({ type: 'focus:drift' });
  await host.next(focusEvent('drift'));
  const hostClosed = once(host.ws, 'close');
  const memberClosed = once(member.ws, 'close');
  host.send({ type: 'focus:end' });
  const hostSummary = (await host.next('session:summary')).summary;
  const memberSummary = (await member.next('session:summary')).summary;
  await Promise.all([host.next('session:ended'), member.next('session:ended'), hostClosed, memberClosed]);
  assert.equal(hostSummary.sessionId, memberSummary.sessionId);
  assert.equal(hostSummary.score, memberSummary.score);
  assert.equal(hostSummary.score, computeSessionScore({ ...hostSummary, missionFrac: 0 }));
  assert.equal(hostSummary.grade, gradeForScore(hostSummary.score));
  assert.equal(hostSummary.drifts, 1);
  assert.equal(hostSummary.contributions, 1);
  assert.equal(hostSummary.collaborations, 0);
  assert.equal(memberSummary.contributions, 0);
  assert.equal(memberSummary.collaborations, 1);
  const fresh = await connect();
  assert.notEqual((await join(fresh, 'focus-end', 'New host')).room.focus.sessionId, hostSummary.sessionId);
});

test('a failed solo automatic window does not block the first manual alignment when another person arrives', async () => {
  const host = await connect();
  const joined = await join(host, 'focus-late-arrival', 'Host');
  assert.equal(joined.room.focus.canStartAlignment, false);
  assert.equal(joined.room.focus.nextAlignmentInMs, 0);
  host.send({ type: 'focus:sync-start' });
  assert.equal((await host.next('error')).code, 'ALIGNMENT_NEEDS_GROUP');
  await advanceServerClock(45000);
  // Also refresh transport activity after moving the child clock forward.
  host.send({ type: 'ping' });
  const attempted = await host.next((message) => message.type === 'focus:state' && message.focus.elapsedMs >= 45000);
  assert.equal(attempted.focus.alignment, null);
  assert.equal(attempted.focus.canStartAlignment, false);
  assert.equal(attempted.focus.nextAlignmentInMs, 0);
  const member = await connect();
  const memberJoined = await join(member, 'focus-late-arrival', 'Member');
  assert.equal(memberJoined.room.focus.canStartAlignment, true);
  assert.equal(memberJoined.room.focus.nextAlignmentInMs, 0);
  host.send({ type: 'focus:sync-start' });
  const started = await host.next((message) => message.type === 'focus:state' && message.focus.alignment);
  assert.equal(started.focus.alignment.participantIds.length, 2);
  assert.equal(started.focus.canStartAlignment, false);
  assert.equal(started.focus.nextAlignmentInMs, 75000);
});
