'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { before, after, test } = require('node:test');
const { WebSocket } = require('ws');

let serverProcess;
let baseUrl;
const sockets = new Set();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sharedSecret = 'integration-test-turn-secret';

before(async () => {
  serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: '0', HOST: '127.0.0.1',
      QUORUM_SWEEP_MS: '25', QUORUM_HEARTBEAT_MS: '50',
      QUORUM_CONNECTION_TIMEOUT_MS: '300', QUORUM_RECONNECT_GRACE_MS: '800',
      TURN_URLS: 'turn:relay.example.test:3478,turns:relay.example.test:5349?transport=tcp',
      TURN_SHARED_SECRET: sharedSecret,
      TURN_TTL_SECONDS: '120'
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 8000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/Site:\s+http:\/\/localhost:(\d+)/);
      if (match) {
        baseUrl = `http://127.0.0.1:${match[1]}`;
        clearTimeout(timer);
        resolve();
      }
    };
    serverProcess.stdout.on('data', onData);
    serverProcess.stderr.on('data', (chunk) => { output += chunk.toString(); });
    serverProcess.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited (${code}): ${output}`));
    });
    serverProcess.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
});

after(async () => {
  for (const socket of sockets) socket.terminate();
  if (serverProcess?.exitCode === null) {
    const exited = once(serverProcess, 'exit');
    serverProcess.kill();
    await exited;
  }
});

async function connect(options = {}) {
  const ws = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/quorum-space`, options);
  sockets.add(ws);
  const messages = [];
  const waiting = new Set();
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
  // Expected heartbeat failures and replacement sockets can emit errors.
  ws.on('error', () => {});
  await once(ws, 'open');
  return {
    ws,
    send: (message) => ws.send(JSON.stringify(message)),
    next(predicate, timeout = 3000) {
      if (typeof predicate === 'string') {
        const type = predicate;
        predicate = (message) => message.type === type;
      }
      const index = messages.findIndex(predicate);
      if (index !== -1) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          waiting.delete(waiter);
          reject(new Error('Timed out waiting for a Quorum message'));
        }, timeout);
        waiting.add(waiter);
      });
    }
  };
}

async function join(client, roomId, name, extra = {}) {
  client.send({ type: 'join', roomId, name, ...extra });
  return client.next('joined');
}

test('health, static room invites and expiring TURN credentials are available', async () => {
  const health = await fetch(`${baseUrl}/healthz`);
  assert.deepEqual(await health.json(), { status: 'ok', service: 'velos-quorum' });
  const invite = await fetch(`${baseUrl}/cedar-ab`, { redirect: 'manual' });
  assert.equal(invite.status, 302);
  assert.equal(invite.headers.get('location'), '/quorum/?room=cedar-ab');
  const response = await fetch(`${baseUrl}/quorum-config`);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const config = await response.json();
  const relay = config.iceServers[1];
  assert.equal(relay.urls.length, 2);
  const expiry = Number(relay.username.split(':')[0]);
  assert.ok(expiry > Date.now() / 1000 + 100);
  assert.ok(expiry <= Date.now() / 1000 + 120);
  assert.equal(relay.credential, crypto.createHmac('sha1', sharedSecret).update(relay.username).digest('base64'));
  assert.ok(!JSON.stringify(config).includes(sharedSecret));
});

test('static hosting protects environment files and server-only relay code', async () => {
  for (const requestPath of ['/.env', '/.env.example', '/%2eenv', '/node_modules/ws/package.json', '/rtc-config.js', '/server.js']) {
    const response = await fetch(`${baseUrl}${requestPath}`, { redirect: 'manual' });
    assert.equal(response.status, 403, `${requestPath} must not be served to browsers`);
  }
  const client = await fetch(`${baseUrl}/quorum/quorum-app.js`);
  assert.equal(client.status, 200);
});

test('server control heartbeats keep an idle browser alive without JavaScript pings', async () => {
  const client = await connect();
  let controlPings = 0;
  client.ws.on('ping', () => { controlPings += 1; });
  await join(client, 'idle-heartbeat', 'Host');
  await delay(700);
  assert.ok(controlPings >= 3);
  assert.equal(client.ws.readyState, WebSocket.OPEN);
  client.send({ type: 'ping' });
  await client.next('pong');
});

test('a participant resumes identity, host, layout, ballot and profile after a dropped socket', async () => {
  const host = await connect();
  const member = await connect();
  const hostJoined = await join(host, 'resume-state', 'Host');
  const memberJoined = await join(member, 'resume-state', 'Member', { profile: { department: 'Design' } });
  host.send({ type: 'host:group-create', name: 'Team' });
  const groupState = await host.next((msg) => msg.type === 'state' && msg.reason === 'group-created');
  const groupId = groupState.room.groups[0].id;
  host.send({ type: 'host:move', peerId: memberJoined.selfId, x: 0.3, y: 0.4, groupId });
  await host.next((msg) => msg.type === 'state' && msg.reason === 'layout');
  host.send({ type: 'host:vote-open' });
  await member.next((msg) => msg.type === 'state' && msg.reason === 'vote-open');
  member.send({ type: 'vote', choice: 'yes', source: 'gesture' });
  await host.next((msg) => msg.type === 'state' && msg.reason === 'vote');
  host.ws.terminate();
  const disconnected = await member.next((msg) => msg.type === 'state' && msg.reason === 'peer-disconnected');
  assert.equal(disconnected.room.hostId, hostJoined.selfId);
  assert.equal(disconnected.room.participants.find((p) => p.id === hostJoined.selfId).connected, false);
  assert.ok(disconnected.room.participants.every((p) => !('resumeToken' in p) && !('profile' in p)));
  const resumedHost = await connect();
  const resumed = await join(resumedHost, 'resume-state', 'Other name', { resumeToken: hostJoined.resumeToken });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.selfId, hostJoined.selfId);
  assert.equal(resumed.room.hostId, hostJoined.selfId);
  assert.equal(resumed.room.participants.length, 2);
  assert.equal(resumed.room.participants.find((p) => p.id === resumed.selfId).name, 'Host');
  const savedMember = resumed.room.participants.find((p) => p.id === memberJoined.selfId);
  assert.deepEqual(savedMember.box, { x: 0.3, y: 0.4 });
  assert.equal(savedMember.groupId, groupId);
  assert.equal(savedMember.vote, 'yes');
  assert.equal(savedMember.gestureVotes, 1);
  assert.equal(savedMember.profile.department, 'Design');
  const rejoined = await member.next('peer-rejoined');
  assert.equal(rejoined.participant.id, hostJoined.selfId);
  assert.ok(!JSON.stringify(rejoined).includes(hostJoined.resumeToken));
});

test('a resumed socket replaces a stale socket without its later close deleting the participant', async () => {
  const original = await connect();
  const joined = await join(original, 'replace-socket', 'Host');
  const oldClosed = once(original.ws, 'close');
  const replacement = await connect();
  const resumed = await join(replacement, 'replace-socket', 'Host', { resumeToken: joined.resumeToken });
  await oldClosed;
  assert.equal(resumed.selfId, joined.selfId);
  replacement.send({ type: 'host:motion', text: 'Still the host' });
  const state = await replacement.next((msg) => msg.type === 'state' && msg.reason === 'motion');
  assert.equal(state.room.motion, 'Still the host');
  assert.equal(state.room.participants.length, 1);
});

test('unresponsive sockets are detected and host succession happens only after reconnect grace', async () => {
  const host = await connect({ autoPong: false });
  const member = await connect();
  const joined = await join(host, 'heartbeat-expiry', 'Host');
  const memberJoined = await join(member, 'heartbeat-expiry', 'Member');
  await once(host.ws, 'close');
  const disconnected = await member.next((msg) => msg.type === 'state' && msg.reason === 'peer-disconnected');
  assert.equal(disconnected.room.hostId, joined.selfId);
  const left = await member.next('peer-left');
  assert.equal(left.peerId, joined.selfId);
  assert.equal(left.room.hostId, memberJoined.selfId);
  assert.equal(left.room.participants.length, 1);
  const expired = await connect();
  const fresh = await join(expired, 'heartbeat-expiry', 'Host', { resumeToken: joined.resumeToken });
  assert.equal(fresh.resumed, false);
  assert.notEqual(fresh.selfId, joined.selfId);
  assert.equal(fresh.room.hostId, memberJoined.selfId);
});

test('explicit leave transfers hosting immediately and an emptied room starts cleanly', async () => {
  const host = await connect();
  const member = await connect();
  const joined = await join(host, 'explicit-leave', 'Host');
  const memberJoined = await join(member, 'explicit-leave', 'Member');
  host.send({ type: 'leave' });
  const left = await member.next('peer-left');
  assert.equal(left.peerId, joined.selfId);
  assert.equal(left.hostId, memberJoined.selfId);
  const closed = once(member.ws, 'close');
  member.send({ type: 'leave' });
  await closed;
  const fresh = await connect();
  const freshJoined = await join(fresh, 'explicit-leave', 'New host');
  assert.equal(freshJoined.room.participants.length, 1);
  assert.equal(freshJoined.room.hostId, freshJoined.selfId);
  assert.equal(freshJoined.room.groups.length, 0);
});

test('a full room accepts a valid resume but never grants identity from an invalid token', async () => {
  const host = await connect();
  const joined = await join(host, 'full-room-resume', 'Host');
  for (let index = 0; index < 15; index += 1) {
    const member = await connect();
    await join(member, 'full-room-resume', `Member ${index + 1}`);
  }
  const stranger = await connect();
  stranger.send({ type: 'join', roomId: 'full-room-resume', name: 'Host', resumeToken: 'not-a-valid-token' });
  assert.equal((await stranger.next('room-full')).maxParticipants, 16);
  const replacement = await connect();
  const resumed = await join(replacement, 'full-room-resume', 'Host', { resumeToken: joined.resumeToken });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.selfId, joined.selfId);
  assert.equal(resumed.room.participants.length, 16);
  assert.equal(resumed.room.hostId, joined.selfId);
});
