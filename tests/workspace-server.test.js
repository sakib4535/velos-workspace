'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { before, after, test } = require('node:test');
const { WebSocket } = require('ws');
const { computeSessionScore } = require('../lib/quorum-core.cjs');

let serverProcess;
let wsUrl;
const sockets = new Set();

before(async () => {
  serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', QUORUM_RECONNECT_GRACE_MS: '3000' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
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
        waiter.timer = setTimeout(() => { waiting.delete(waiter); reject(new Error('Timed out waiting for workspace message')); }, timeout);
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

const workspaceState = (predicate = () => true) => (message) => message.type === 'state' && message.reason === 'workspace' && predicate(message.room.tools);
const workspaceError = (code) => (message) => message.type === 'error' && message.code === code;

test('decision ballots synchronize private votes, survive resume, reject late voters and produce outcomes', async () => {
  const host = await connect(), guest = await connect();
  await join(host, 'decision-live', 'Host');
  const g = await join(guest, 'decision-live', 'Guest');
  guest.send({ type:'decision:create', kind:'topic', title:'Next direction?', options:['Explore','Build'], multiple:true });
  const created = await host.next(m => m.type==='state' && m.reason==='decisions');
  const b = created.room.decisions.ballots[0];
  assert.equal(b.eligibleCount,2);
  guest.send({type:'decision:vote',id:b.id,value:[0,1]});
  const voted = await host.next(m=>m.type==='state' && m.room.decisions?.ballots[0]?.responded===1);
  assert.deepEqual(voted.room.decisions.ballots[0].values,[1,1]);
  assert.equal(voted.room.decisions.ballots[0].mine,null);
  assert.equal(JSON.stringify(voted.room.decisions).includes(g.selfId),false);
  const late=await connect();await join(late,'decision-live','Late');
  late.send({type:'decision:vote',id:b.id,value:[0]});await late.next(workspaceError('DECISION_INVALID'));
  guest.ws.terminate();
  const resumed=await connect();const reply=await join(resumed,'decision-live','Guest',{resumeToken:g.resumeToken});
  assert.deepEqual(reply.room.decisions.ballots[0].mine,[0,1]);
  resumed.send({type:'decision:conclusion',id:b.id,conclusion:'Build a small prototype.'});
  await host.next(m=>m.type==='state' && m.room.decisions?.ballots[0]?.conclusion==='Build a small prototype.');
  resumed.send({type:'decision:close',id:b.id});await host.next(m=>m.type==='state' && m.room.decisions?.ballots[0]?.open===false);
  host.send({type:'leave'});const summary=await host.next('session:summary');
  assert.equal(summary.summary.outcomes.ballotsClosed,1);assert.equal(summary.summary.outcomes.conclusions[0].conclusion,'Build a small prototype.');
});

test('check-in broadcasts never leak another response and co-facilitators can publish a batch', async () => {
  const host=await connect(),guest=await connect(),third=await connect();
  await join(host,'thinking-live','Host');const g=await join(guest,'thinking-live','Guest');await join(third,'thinking-live','Third');
  host.send({type:'thinking:cohost',id:g.selfId});await guest.next(m=>m.type==='state' && m.room.decisions?.canManage);
  guest.send({type:'thinking:start'});await host.next(m=>m.type==='state' && m.room.decisions?.checkinOpen);
  host.send({type:'thinking:respond',round:1,value:'clear'});
  await host.next(m=>m.type==='state' && m.room.decisions?.myCheckin==='clear');
  const hidden=await currentRoom(third);
  assert.equal(hidden.decisions.myCheckin,null);assert.equal(hidden.decisions.published,null);
  guest.send({type:'thinking:respond',round:1,value:'context'});await guest.next(m=>m.type==='state' && m.room.decisions?.myCheckin==='context');
  third.send({type:'thinking:respond',round:1,value:'pause'});await third.next(m=>m.type==='state' && m.room.decisions?.myCheckin==='pause');
  guest.send({type:'thinking:finish'});
  const result=await host.next(m=>m.type==='state' && m.room.decisions?.published);
  assert.deepEqual(result.room.decisions.published,{total:3,counts:[1,1,1]});
  assert.equal(result.room.decisions.myCheckin,null);
});

async function create(client, kind, extra = {}) {
  client.send({ type: 'workspace:create', kind, ...extra });
  const state = await client.next(workspaceState());
  return state.room.tools.at(-1);
}

test('any participant can create, use, move and delete a synchronized tool screen', async () => {
  const host = await connect();
  const member = await connect();
  const initial = await join(host, 'workspace-shared', 'Host');
  const joined = await join(member, 'workspace-shared', 'Member');
  assert.deepEqual(initial.room.tools, []);
  const notes = await create(member, 'notes', { title: 'Meeting notes', x: -1.4, y: 2.6 });
  assert.equal(notes.createdBy, joined.selfId);
  assert.deepEqual(notes.data, { text: '' });
  assert.equal(notes.x, -1.4);
  assert.equal(notes.y, 2.6);
  assert.ok(notes.w > 0 && notes.h > 0);
  const shared = await host.next(workspaceState((tools) => tools.some((tool) => tool.id === notes.id)));
  assert.deepEqual(shared.room.tools[0], notes);
  host.send({ type: 'workspace:update', id: notes.id, baseVersion: notes.version, data: { text: 'First decision\nNext step' } });
  const edited = (await member.next(workspaceState((tools) => tools[0]?.version === 2))).room.tools[0];
  assert.equal(edited.data.text, 'First decision\nNext step');
  member.send({ type: 'workspace:update', id: notes.id, x: 3.5, y: -4.5, w: 0.7, h: 0.6 });
  const moved = (await member.next(workspaceState((tools) => tools[0]?.version === 3))).room.tools[0];
  assert.equal(moved.x, 3.5);
  assert.equal(moved.w, 0.7);
  member.send({ type: 'workspace:delete', id: notes.id, baseVersion: 3 });
  await member.next(workspaceState((tools) => tools.length === 0));
  assert.deepEqual((await currentRoom(host)).tools, []);
});

test('stale or missing document versions cannot overwrite another participant; conflict includes fresh state', async () => {
  const client = await connect();
  await join(client, 'workspace-conflicts', 'Host');
  const notes = await create(client, 'notes');
  client.send({ type: 'workspace:update', id: notes.id, baseVersion: 1, data: { text: 'Saved by participant A' } });
  await client.next(workspaceState((tools) => tools[0]?.version === 2));
  client.send({ type: 'workspace:update', id: notes.id, baseVersion: 1, data: { text: 'Stale draft' } });
  const conflict = await client.next(workspaceError('WORKSPACE_CONFLICT'));
  assert.equal(conflict.tool.version, 2);
  assert.equal(conflict.tool.data.text, 'Saved by participant A');
  assert.equal(conflict.room.tools[0].data.text, 'Saved by participant A');
  client.send({ type: 'workspace:update', id: notes.id, data: { text: 'No version draft' } });
  await client.next(workspaceError('WORKSPACE_CONFLICT'));
  client.send({ type: 'workspace:delete', id: notes.id, baseVersion: 1 });
  await client.next(workspaceError('WORKSPACE_CONFLICT'));
  assert.equal((await currentRoom(client)).tools[0].data.text, 'Saved by participant A');
});

test('tool documents validate supported notes, tasks, board and timer data', async () => {
  const client = await connect();
  await join(client, 'workspace-documents', 'Host');
  const cases = [
    ['notes', { text: 'Text\nline\twith\u0000control' }, { text: 'Text\nline\twithcontrol' }],
    ['tasks', { items: [{ id: 'task-1', text: 'Ship workspace', done: true }] }],
    ['board', { strokes: [{ id: 'line-1', color: '#66DFBD', width: 3, points: [{ x: 0.123456, y: 0.5 }] }] }, { strokes: [{ id: 'line-1', color: '#66dfbd', width: 3, points: [{ x: 0.1235, y: 0.5 }] }] }],
    ['timer', { durationMs: 60000, startedAt: Date.now(), running: true }]
  ];
  for (const [kind, data, expected = data] of cases) {
    const tool = await create(client, kind, { data });
    assert.deepEqual(tool.data, expected);
  }
  const invalid = [
    ['notes', { text: 'x'.repeat(20001) }],
    ['tasks', { items: [{ id: 'same', text: 'A', done: false }, { id: 'same', text: 'B', done: false }] }],
    ['tasks', { items: [{ id: 'bad', text: 'A', done: 'false' }] }],
    ['board', { strokes: [{ id: 'bad', color: 'url(https://example.com)', width: 3, points: [{ x: 0, y: 0 }] }] }],
    ['board', { strokes: [{ id: 'bad', color: '#ffffff', width: 3, points: [{ x: -1, y: 0 }] }] }],
    ['board', { strokes: [{ id: 'big', color: '#ffffff', width: 3, points: Array.from({ length: 4001 }, () => ({ x: 0, y: 0 })) }] }],
    ['timer', { durationMs: 60000, startedAt: null, running: true }],
    ['timer', { durationMs: 86400001, startedAt: null, running: false }]
  ];
  for (const [kind, data] of invalid) {
    client.send({ type: 'workspace:create', kind, data });
    await client.next(workspaceError('WORKSPACE_INVALID'));
  }
  assert.equal((await currentRoom(client)).tools.length, cases.length);
});

test('embed URLs support HTTPS and local development while rejecting unsafe schemes and private destinations', async () => {
  const client = await connect();
  await join(client, 'workspace-embeds', 'Host');
  const allowed = ['https://example.com/tool?view=board', 'http://localhost:3000/tool', 'http://127.0.0.1:8788/app/', 'http://[::1]:3000/'];
  for (const url of allowed) assert.equal((await create(client, 'embed', { url })).url, new URL(url).href);
  const blocked = [
    'javascript:alert(1)', 'data:text/html,<h1>tool</h1>', 'file:///c:/secret',
    'http://example.com/', 'https://user:password@example.com/', 'https://192.168.1.2/',
    'https://10.0.0.1/', 'https://172.16.0.1/', 'https://169.254.169.254/latest/',
    'https://100.64.0.1/', 'https://2130706433/', 'https://router.local/',
    'https://metadata.google.internal/', 'https://[fc00::1]/', 'https://[::ffff:192.168.1.2]/'
  ];
  for (const url of blocked) {
    client.send({ type: 'workspace:create', kind: 'embed', url });
    await client.next(workspaceError('WORKSPACE_INVALID'));
  }
  assert.equal((await currentRoom(client)).tools.length, allowed.length);
});

test('workspace content survives participant socket replacement and room resume', async () => {
  const client = await connect();
  const joined = await join(client, 'workspace-resume', 'Host');
  const notes = await create(client, 'notes', { data: { text: 'Retained shared state' }, x: -3 });
  const closed = once(client.ws, 'close');
  client.ws.terminate();
  await closed;
  const replacement = await connect();
  const resumed = await join(replacement, 'workspace-resume', 'Host', { resumeToken: joined.resumeToken });
  assert.equal(resumed.resumed, true);
  assert.deepEqual(resumed.room.tools[0], notes);
  const newcomer = await connect();
  assert.deepEqual((await join(newcomer, 'workspace-resume', 'New participant')).room.tools[0], notes);
});

test('workspace screen count is bounded and malformed updates cannot corrupt existing screens', async () => {
  const client = await connect();
  await join(client, 'workspace-limits', 'Host');
  const first = await create(client, 'notes');
  for (let index = 1; index < 12; index += 1) await create(client, 'notes');
  client.send({ type: 'workspace:create', kind: 'notes' });
  await client.next(workspaceError('WORKSPACE_LIMIT'));
  for (const update of [{ x: 101 }, { w: 0.01 }, { h: 20 }, { title: '' }, { x: 'NaN' }]) {
    client.send({ type: 'workspace:update', id: first.id, ...update });
    await client.next(workspaceError('WORKSPACE_INVALID'));
  }
  const room = await currentRoom(client);
  assert.equal(room.tools.length, 12);
  assert.equal(room.tools[0].version, 1);
  assert.equal(room.tools[0].w, first.w);
});

test('shared checklist completion feeds meeting progress and rewards each task only once', async () => {
  const client = await connect();
  await join(client, 'workspace-task-focus', 'Host');
  const data = { items: [
    { id: 'one', text: 'First decision', done: false },
    { id: 'two', text: 'Next step', done: false }
  ] };
  const tasks = await create(client, 'tasks', { data });
  const initial = (await currentRoom(client)).focus;
  assert.equal(initial.itemsTotal, 2);
  assert.equal(initial.itemsCompleted, 0);
  data.items[0].done = true;
  client.send({ type: 'workspace:update', id: tasks.id, baseVersion: 1, data });
  const completed = await client.next((message) => message.type === 'focus:state' && message.focus.lastEvent?.key === 'close');
  assert.equal(completed.focus.itemsCompleted, 1);
  assert.equal(completed.focus.itemsTotal, 2);
  assert.ok(Math.abs(completed.focus.energy - initial.energy - 5) < 0.6);
  await client.next(workspaceState((tools) => tools[0]?.version === 2));
  data.items[0].done = false;
  client.send({ type: 'workspace:update', id: tasks.id, baseVersion: 2, data });
  await client.next(workspaceState((tools) => tools[0]?.version === 3));
  data.items[0].done = true;
  client.send({ type: 'workspace:update', id: tasks.id, baseVersion: 3, data });
  const repeated = await client.next(workspaceState((tools) => tools[0]?.version === 4));
  assert.ok(repeated.room.focus.energy <= completed.focus.energy);
  assert.equal(repeated.room.focus.itemsCompleted, 1);
  client.send({ type: 'leave' });
  const { summary } = await client.next('session:summary');
  assert.equal(summary.itemsTotal, 2);
  assert.equal(summary.itemsCompleted, 1);
  assert.equal(summary.score, computeSessionScore({ avgEnergy: summary.avgEnergy, missionFrac: 0.5,
    bestChain: summary.bestChain, syncsWon: summary.syncsWon, drifts: summary.drifts }));
});

test('room document budget rejects oversized growth without removing existing content', async () => {
  const client = await connect();
  await join(client, 'workspace-document-budget', 'Host');
  const data = { strokes: [{ id: 'stroke', color: '#66dfbd', width: 3,
    points: Array.from({ length: 4000 }, () => ({ x: 0.1234, y: 0.5678 })) }] };
  let created = 0;
  for (; created < 12; created += 1) {
    client.send({ type: 'workspace:create', kind: 'board', data });
    const result = await client.next((message) => workspaceState()(message) || workspaceError('WORKSPACE_LIMIT')(message));
    if (result.type === 'error') break;
  }
  assert.ok(created >= 2 && created < 12);
  const room = await currentRoom(client);
  assert.equal(room.tools.length, created);
  assert.deepEqual(room.tools[0].data, data);
  assert.ok(Buffer.byteLength(JSON.stringify(room.tools)) <= 384 * 1024);
});

test('free world layout allows self movement and host group travel outside the starting stage', async () => {
  const host = await connect();
  const member = await connect();
  const hostJoined = await join(host, 'workspace-world', 'Host');
  const joined = await join(member, 'workspace-world', 'Member');
  member.send({ type: 'participant:move', peerId: joined.selfId, x: -1.5, y: 2.4 });
  const selfMoved = await member.next((message) => message.type === 'state' && message.reason === 'layout');
  assert.deepEqual(selfMoved.room.participants.find((person) => person.id === joined.selfId).box, { x: -1.5, y: 2.4 });
  member.send({ type: 'host:move', peerId: hostJoined.selfId, x: 5, y: 5 });
  await member.next((message) => message.type === 'error' && message.code === 'HOST_ONLY');
  host.send({ type: 'host:group-create', name: 'Far team', x: -2, y: 3 });
  const group = (await host.next((message) => message.type === 'state' && message.reason === 'group-created')).room.groups[0];
  assert.equal(group.x, -2);
  assert.equal(group.y, 3);
  host.send({ type: 'host:move', peerId: joined.selfId, x: -2, y: 3, groupId: group.id });
  await host.next((message) => message.type === 'state' && message.reason === 'layout');
  host.send({ type: 'host:group-update', groupId: group.id, x: 4, y: -5 });
  const moved = await host.next((message) => message.type === 'state' && message.reason === 'layout');
  assert.deepEqual(moved.room.participants.find((person) => person.id === joined.selfId).box, { x: 4, y: -5 });
  assert.equal(moved.room.groups[0].x, 4);
  assert.equal(moved.room.groups[0].y, -5);
});
