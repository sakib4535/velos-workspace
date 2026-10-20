import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmbedUrl, timerRemaining, formatTimer, reconcileDraft, exportToolDocument, screenPlacement, TOOL_DEFAULTS, createWorkspaceUI } from '../quorum/workspace-tools.mjs';

test('remote embeds retain their origin and reject executable URLs, credentials and our own origin', () => {
  assert.equal(normalizeEmbedUrl('https://example.org/embed?doc=7', 'https://velos.example'), 'https://example.org/embed?doc=7');
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'http://example.org', 'https://name:secret@example.org', 'https://velos.example/tool', 'https://192.168.1.5', 'https://10.0.0.2', 'https://printer.local', 'https://[2001:db8::1]']) {
    assert.throws(() => normalizeEmbedUrl(url, 'https://velos.example'), url);
  }
  assert.equal(normalizeEmbedUrl('http://localhost:3000'), 'http://localhost:3000/');
  assert.throws(() => normalizeEmbedUrl('http://localhost:8788/quorum/', 'http://localhost:8788'));
});

test('shared timer derives remaining time from the shared clock without per-second network updates', () => {
  const running = { durationMs: 90000, startedAt: 1000, running: true };
  assert.equal(timerRemaining(running, 31000), 60000);
  assert.equal(timerRemaining(running, 100000), 0);
  assert.equal(timerRemaining({ ...running, running: false }, 31000), 90000);
  assert.equal(timerRemaining(running, 0), 90000);
  assert.equal(formatTimer(60001), '01:01');
  assert.equal(formatTimer(0), '00:00');
});

test('a save acknowledgement clears the draft only if no new typing followed the send', () => {
  const base = { text: 'Original' }, sent = { text: 'First edit' };
  const draft = { baseData: base, baseVersion: 1, data: sent, pendingData: sent };
  assert.deepEqual(reconcileDraft(draft, { version: 2, data: sent }), { status: 'clean', draft: null });
  const newer = { ...draft, data: { text: 'First edit plus more' } };
  const result = reconcileDraft(newer, { version: 2, data: sent });
  assert.equal(result.status, 'dirty');
  assert.equal(result.draft.data.text, 'First edit plus more');
  assert.equal(result.draft.baseVersion, 2);
  assert.equal(result.draft.pendingData, null);
  assert.equal(newer.baseVersion, 1, 'reconciliation does not mutate the old draft');
});

test('moving a screen rebases an unsent draft; concurrent content changes require review', () => {
  const draft = { baseData: { text: 'Original' }, baseVersion: 1, data: { text: 'My words' }, pendingData: null };
  const layout = reconcileDraft(draft, { version: 2, data: { text: 'Original' }, x: .6 });
  assert.equal(layout.status, 'dirty');
  assert.equal(layout.draft.baseVersion, 2);
  const concurrent = reconcileDraft(draft, { version: 2, data: { text: 'Someone else’s words' } });
  assert.equal(concurrent.status, 'conflict');
  assert.equal(concurrent.draft.data.text, 'My words');
  assert.equal(concurrent.draft.pendingData, null);
});

test('download preserves useful work, including unfinished drafts and a portable drawing', () => {
  assert.equal(exportToolDocument({ kind: 'notes', title: 'Our / decisions', data: { text: 'Saved' } }, { text: 'Draft decision' }).content, 'Draft decision');
  assert.equal(exportToolDocument({ kind: 'notes', title: 'Our / decisions', data: { text: '' } }).filename, 'Our - decisions.txt');
  const tasks = exportToolDocument({ kind: 'tasks', title: 'Next steps', data: { items: [{ text: 'Ship it', done: true }, { text: 'Review', done: false }] } });
  assert.match(tasks.content, /- \[x\] Ship it\n- \[ \] Review/);
  const board = exportToolDocument({ kind: 'board', title: '<Design & build>', data: { strokes: [{ id: 's1', color: '#66dfbd', width: 4, points: [{ x: .1, y: .2 }, { x: .8, y: .9 }] }] } });
  assert.equal(board.mime, 'image/svg+xml;charset=utf-8');
  assert.match(board.content, /&lt;Design &amp; build&gt;/);
  assert.match(board.content, /points="100,120 800,540"/);
});

test('new screens occupy free space beside people and existing channels', () => {
  const room = { participants: [{ id: 'member-1', box: { x: .5, y: .5 } }, { id: 'member-without-position' }], tools: [] };
  const first = screenPlacement({ x: .5, y: .5 }, 'notes', room);
  assert.ok(first.x >= .61, 'the first screen clears the participant tile');
  room.tools.push({ ...first, ...TOOL_DEFAULTS.notes });
  const second = screenPlacement({ x: .5, y: .5 }, 'notes', room);
  const size = TOOL_DEFAULTS.notes;
  assert.ok(second.x + size.w <= first.x || second.x >= first.x + size.w || second.y + size.h <= first.y || second.y >= first.y + size.h, 'a second screen does not cover the first');
  const far = screenPlacement({ x: -3, y: 4 }, 'board', { participants: [], tools: [] });
  assert.ok(far.x < -2, 'placement respects the current view outside the initial room bounds');
});

function editorFixture(tool) {
  class Node {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.style = { setProperty() {} }; this.classList = { toggle() {}, add() {}, remove() {} }; this.value = ''; this.selectionStart = 0; this.selectionEnd = 0; }
    append(...nodes) { nodes.forEach(node => { node.parentNode = this; this.children.push(node); }); }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
    emit(type, details = {}) { const event = { target: this, preventDefault() {}, stopPropagation() {}, ...details }; for (const callback of this.listeners[type] || []) callback(event); }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); }
  }
  const container = new Node('div');
  const doc = { body: new Node('body'), activeElement: null, createElement: tag => new Node(tag), getElementById: id => id === 'qToolScreens' ? container : null, querySelectorAll: () => [] };
  const sent = [];
  let room = { tools: [tool] };
  const ui = createWorkspaceUI({ read: () => ({ joined: true, room, selfId: 'host' }), send: message => { sent.push(message); return true; } }, { document: doc, window: { location: { origin: 'https://velos.example' } } });
  function find(className, node = container) { if ((node.className || '').split(' ').includes(className)) return node; for (const child of node.children) { const result = find(className, child); if (result) return result; } return null; }
  return { doc, sent, ui, find, update(next) { room = { tools: [next] }; ui.updateRoom(room); } };
}

test('a focused clean note receives remote edits before the next keystroke, while a dirty draft stays visible', () => {
  const tool = { id: 'note-1', kind: 'notes', title: 'Decisions', x: .6, y: .3, w: .275, h: .34, version: 1, data: { text: 'Original words' } };
  const fixture = editorFixture(tool);
  try {
    const input = fixture.find('q-tool-notes');
    fixture.doc.activeElement = input;
    input.selectionStart = 10; input.selectionEnd = 10;
    fixture.update({ ...tool, version: 2, data: { text: 'Peer' } });
    assert.equal(input.value, 'Peer', 'focused clean content must not remain stale');
    assert.equal(input.selectionStart, 4, 'caret is preserved within the new text bounds');
    input.value = 'Peer plus mine'; input.emit('input'); input.emit('blur');
    assert.equal(fixture.sent.at(-1).baseVersion, 2);
    assert.equal(fixture.sent.at(-1).data.text, 'Peer plus mine');
    fixture.update({ ...tool, version: 3, data: { text: 'Another person’s decision' } });
    assert.equal(input.value, 'Peer plus mine', 'a conflicting room update preserves the visible unsaved work');
    assert.equal(fixture.find('q-tool-conflict').hidden, false);
  } finally { fixture.ui.reset(); }
});

test('new typing made while a note save is in flight survives the acknowledgement and saves against its version', () => {
  const tool = { id: 'note-2', kind: 'notes', title: 'Ideas', x: .6, y: .3, w: .275, h: .34, version: 1, data: { text: '' } };
  const fixture = editorFixture(tool);
  try {
    const input = fixture.find('q-tool-notes'); fixture.doc.activeElement = input;
    input.value = 'First idea'; input.emit('input'); input.emit('blur');
    input.value = 'First idea, developed'; input.emit('input');
    fixture.update({ ...tool, version: 2, data: { text: 'First idea' } });
    assert.equal(input.value, 'First idea, developed');
    input.emit('blur');
    assert.equal(fixture.sent.length, 2);
    assert.equal(fixture.sent[1].baseVersion, 2);
    assert.equal(fixture.sent[1].data.text, 'First idea, developed');
  } finally { fixture.ui.reset(); }
});

test('capture loss or cancellation commits the last screen position and releases its drag state', () => {
  const tool = { id: 'move-note', kind: 'notes', title: 'Ideas', x: .6, y: .3, w: .275, h: .34, version: 1, data: { text: '' } };
  const fixture = editorFixture(tool);
  try {
    const header = fixture.find('q-tool-screen-head');
    const target = { closest: () => null };
    header.emit('pointerdown', { pointerId: 1, button: 0, clientX: 320, clientY: 300, target });
    header.emit('pointermove', { pointerId: 1, clientX: 480, clientY: 350 });
    header.emit('lostpointercapture', { pointerId: 1 });
    assert.ok(Math.abs(fixture.sent.at(-1).x - .7) < 1e-9);
    assert.ok(Math.abs(fixture.sent.at(-1).y - .35) < 1e-9);
    header.emit('pointermove', { pointerId: 1, clientX: 800, clientY: 600 });
    assert.equal(fixture.sent.length, 1, 'a lost pointer cannot continue moving the screen');
    header.emit('pointerdown', { pointerId: 2, button: 0, clientX: 480, clientY: 350, target });
    header.emit('pointermove', { pointerId: 2, clientX: 640, clientY: 400 });
    header.emit('pointercancel', { pointerId: 2 });
    assert.ok(Math.abs(fixture.sent.at(-1).x - .8) < 1e-9);
    assert.ok(Math.abs(fixture.sent.at(-1).y - .4) < 1e-9);
  } finally { fixture.ui.reset(); }
});
