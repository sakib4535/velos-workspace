import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFocusUI, createSessionRecorder, focusWavePath } from '../quorum/focus-ui.mjs';
import { isoWeekKey } from '../quorum/focus-core.mjs';

const PROFILE_KEY = 'velos.profile.v1';
const LEDGER_KEY = 'velos.sessions.v1';
const SIDEBAR_KEY = 'velos.quorum.sidebar.v1';
const localDate = (year, month, day) => new Date(year, month - 1, day, 12);

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    values,
  };
}

class FakeElement {
  constructor(id, document) {
    this.id = id;
    this.document = document;
    this.events = new Map();
    this.attributes = new Map();
    this.styles = new Map();
    this.classes = new Set();
    this.style = { setProperty: (name, value) => this.styles.set(name, value) };
    this.classList = {
      toggle: (name, enabled) => { if (enabled) this.classes.add(name); else this.classes.delete(name); },
      contains: (name) => this.classes.has(name),
    };
    this.parent = null;
    this.hidden = false;
    this.open = false;
    this.disabled = false;
    this.textContent = '';
  }
  addEventListener(type, callback) {
    const handlers = this.events.get(type) || [];
    handlers.push(callback);
    this.events.set(type, handlers);
  }
  dispatch(type, event = {}) {
    const data = {
      target: this,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...event,
    };
    for (const handler of this.events.get(type) || []) handler(data);
    return data;
  }
  setAttribute(name, value) { this.attributes.set(name, value); if (name === 'open') this.open = true; }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'open') this.open = false; }
  contains(element) {
    let current = element;
    while (current) { if (current === this) return true; current = current.parent; }
    return false;
  }
  closest() { return this.interactive ? this : null; }
  focus() { this.document.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function setup({ mobile = false, joined = true, isHost = true, storage = memoryStorage() } = {}) {
  const elements = new Map();
  const doc = {
    activeElement: null,
    events: new Map(),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement(id, this));
      return elements.get(id);
    },
    addEventListener(type, callback) { this.events.set(type, callback); },
    dispatch(type, event) { this.events.get(type)?.(event); },
  };
  const intervals = new Map();
  const timeouts = new Map();
  const media = { matches: mobile, addEventListener() {} };
  let timer = 0;
  const win = {
    innerWidth: mobile ? 400 : 1440,
    localStorage: storage,
    events: new Map(),
    matchMedia: () => media,
    addEventListener(type, callback) { this.events.set(type, callback); },
    setInterval(callback) { intervals.set(++timer, callback); return timer; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(callback) { timeouts.set(++timer, callback); return timer; },
    clearTimeout(id) { timeouts.delete(id); },
  };
  const ctx = {
    joined, isHost, selfId: 'participant-1',
    room: { focus: { sessionId: 'meeting-1', energy: 62, history: [], bestChain: 0, syncsWon: 0, drifts: 0,
      personal: { contributions: 2, collaborations: 1 } } },
  };
  const sent = [];
  let leaveCount = 0;
  let canSend = true;
  const bridge = {
    read: () => ctx,
    send(message) { sent.push(message); return canSend; },
    leave() { leaveCount += 1; ctx.joined = false; },
  };
  const controller = createFocusUI(bridge, { document: doc, window: win, storage });
  return {
    controller, doc, win, ctx, storage, sent, intervals, timeouts, media,
    get: (id) => doc.getElementById(id),
    leaveCount: () => leaveCount,
    setCanSend: (value) => { canSend = value; },
    runTimeouts() { for (const callback of [...timeouts.values()]) callback(); },
  };
}

test('session recorder persists each session once across reloads and another recorder instance', () => {
  const storage = memoryStorage();
  const now = () => localDate(2026, 10, 19);
  const first = createSessionRecorder(storage, now);
  const second = createSessionRecorder(storage, now);
  const summary = { sessionId: 'session-1', score: 87, contributions: 4, collaborations: 2 };
  const recorded = first.record(summary);
  assert.equal(recorded.recorded, true);
  assert.equal(recorded.saved, true);
  assert.equal(recorded.profile.sessions, 1);
  assert.equal(first.record(summary).recorded, false);
  assert.equal(second.record(summary).recorded, false);
  assert.equal(createSessionRecorder(storage, now).record(summary).profile.sessions, 1);
  assert.deepEqual(JSON.parse(storage.getItem(LEDGER_KEY)), ['session-1']);
  assert.deepEqual(JSON.parse(storage.getItem(PROFILE_KEY)).weekly,
    { weekKey: '2026-W43', engage: 1, contribute: 4, collaborate: 2 });
});

test('session recorder refreshes shared profile, rolls weeks, and does not duplicate daily streaks', () => {
  const storage = memoryStorage();
  let today = localDate(2026, 10, 18);
  const recorder = createSessionRecorder(storage, () => today);
  recorder.record({ sessionId: 'a', score: 70, contributions: 3, collaborations: 2 });
  let result = recorder.record({ sessionId: 'b', score: 80, contributions: 5, collaborations: 1 });
  assert.equal(result.profile.streak, 1);
  assert.equal(result.profile.sessions, 2);
  assert.equal(result.profile.weekly.engage, 2);
  today = localDate(2026, 10, 19);
  result = recorder.record({ sessionId: 'c', score: 90, contributions: 7, collaborations: 4 });
  assert.equal(result.profile.streak, 2);
  assert.equal(result.profile.sessions, 3);
  assert.deepEqual(result.profile.scoreHistory, [70, 80, 90]);
  assert.deepEqual(result.profile.weekly, { weekKey: '2026-W43', engage: 1, contribute: 7, collaborate: 4 });
  const external = JSON.parse(storage.getItem(PROFILE_KEY));
  external.bestScore = 99;
  storage.setItem(PROFILE_KEY, JSON.stringify(external));
  assert.equal(recorder.read().bestScore, 99);
});

test('session recorder recovers malformed storage and remains usable when persistence is blocked', () => {
  const storage = memoryStorage({ [PROFILE_KEY]: '{broken', [LEDGER_KEY]: '{}' });
  const recorder = createSessionRecorder(storage, () => localDate(2026, 10, 19));
  assert.equal(recorder.read().sessions, 0);
  assert.equal(recorder.record({ score: 70 }).recorded, false);
  assert.equal(recorder.record({ sessionId: 'valid', score: 70 }).profile.sessions, 1);
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const inMemory = createSessionRecorder(blocked, () => localDate(2026, 10, 19));
  const result = inMemory.record({ sessionId: 'offline', score: 75 });
  assert.equal(result.saved, false);
  assert.equal(result.profile.sessions, 1);
  const duplicate = inMemory.record({ sessionId: 'offline', score: 75 });
  assert.equal(duplicate.recorded, false);
  assert.equal(duplicate.saved, false);
  assert.equal(inMemory.read().sessions, 1);
});

test('focus waveform stays finite, bounded, and limited to the recent history window', () => {
  const empty = focusWavePath([], 62);
  assert.equal(empty.line, 'M0.00,25.76 L260.00,25.76');
  assert.equal(empty.area, `${empty.line} L260,64 L0,64 Z`);
  assert.equal(focusWavePath([50], 62).line, 'M0.00,32.00 L260.00,32.00');
  const bounded = focusWavePath([NaN, -1000, Infinity, 1000], NaN);
  assert.equal(bounded.line, 'M0.00,58.00 L260.00,6.00');
  assert.ok(!/NaN|Infinity/.test(focusWavePath([], NaN).line));
  const recent = focusWavePath(Array.from({ length: 200 }, (_, index) => index), 62).line;
  assert.equal((recent.match(/[ML]/g) || []).length, 160);
});

test('desktop sidebar buttons expand the stage, update accessibility, and remember preference', () => {
  const ui = setup();
  assert.equal(ui.get('qFacil').inert, false);
  assert.equal(ui.get('qSidebarToggle').attributes.get('aria-expanded'), 'true');
  ui.get('qSidebarToggle').dispatch('click');
  assert.equal(ui.get('qMeet').classList.contains('q-sidebar-closed'), true);
  assert.equal(ui.get('qFacil').inert, true);
  assert.equal(ui.get('qFacil').attributes.get('aria-hidden'), 'true');
  assert.equal(ui.get('qSidebarToggle').attributes.get('aria-label'), 'Show sidebar');
  assert.equal(ui.storage.getItem(SIDEBAR_KEY), 'true');
  ui.get('qSidebarHandle').dispatch('click');
  assert.equal(ui.get('qMeet').classList.contains('q-sidebar-closed'), false);
  assert.equal(ui.get('qSidebarToggle').attributes.get('aria-expanded'), 'true');
  assert.equal(ui.storage.getItem(SIDEBAR_KEY), 'false');
  ui.get('qSidebarCloseBtn').dispatch('click');
  assert.equal(ui.get('qFacil').inert, true);
});

test('mobile sidebar swipes open from the right edge, close on panel, and ignore vertical gestures', () => {
  const ui = setup({ mobile: true });
  const meet = ui.get('qMeet');
  const surface = ui.get('plainSurface');
  assert.equal(ui.get('qFacil').inert, true);
  meet.dispatch('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 390, clientY: 100, target: surface });
  const moved = meet.dispatch('pointermove', { pointerId: 1, clientX: 300, clientY: 102 });
  assert.equal(moved.defaultPrevented, true);
  meet.dispatch('pointerup', { pointerId: 1, clientX: 300, clientY: 102 });
  assert.equal(ui.get('qFacil').inert, false);
  assert.equal(ui.get('qSidebarBackdrop').hidden, false);
  const panel = ui.get('panelSurface');
  panel.parent = ui.get('qFacil');
  meet.dispatch('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 100, clientY: 100, target: panel });
  meet.dispatch('pointerup', { pointerId: 2, clientX: 105, clientY: 250 });
  assert.equal(ui.get('qFacil').inert, false);
  meet.dispatch('pointerdown', { pointerType: 'touch', pointerId: 3, clientX: 100, clientY: 100, target: panel });
  meet.dispatch('pointerup', { pointerId: 3, clientX: 180, clientY: 105 });
  assert.equal(ui.get('qFacil').inert, true);
  assert.equal(ui.get('qSidebarBackdrop').hidden, true);
});

test('sidebar gestures preserve interactive controls and Escape restores focus when closing', () => {
  const ui = setup({ mobile: true });
  const meet = ui.get('qMeet');
  ui.controller.setSidebar(false);
  const input = ui.get('panelInput');
  input.parent = ui.get('qFacil');
  input.interactive = true;
  meet.dispatch('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 100, target: input });
  meet.dispatch('pointerup', { pointerId: 1, clientX: 200, clientY: 100 });
  assert.equal(ui.get('qFacil').inert, false);
  input.focus();
  ui.doc.dispatch('keydown', { key: 'Escape' });
  assert.equal(ui.get('qFacil').inert, true);
  assert.equal(ui.doc.activeElement, ui.get('qSidebarToggle'));
  ui.controller.setSidebar(false);
  ui.get('qScoreDialog').open = true;
  ui.doc.dispatch('keydown', { key: 'Escape' });
  assert.equal(ui.get('qFacil').inert, false);
});

test('a synthetic handle click after a swipe cannot reverse the sidebar movement', () => {
  const ui = setup({ mobile: true });
  const meet = ui.get('qMeet');
  const handle = ui.get('qSidebarHandle');
  function syntheticClick() {
    const event = meet.dispatch('click', { target: handle });
    if (!event.propagationStopped) handle.dispatch('click', event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);
  }
  ui.controller.setSidebar(false);
  meet.dispatch('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 100, target: handle });
  meet.dispatch('pointerup', { pointerId: 1, clientX: 180, clientY: 100, target: handle });
  assert.equal(ui.get('qFacil').inert, true);
  syntheticClick();
  assert.equal(ui.get('qFacil').inert, true);

  meet.dispatch('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 180, clientY: 100, target: handle });
  meet.dispatch('pointerup', { pointerId: 2, clientX: 100, clientY: 100, target: handle });
  assert.equal(ui.get('qFacil').inert, false);
  syntheticClick();
  assert.equal(ui.get('qFacil').inert, false);
});

test('focus UI renders energy, caps rings, and prevents duplicate action sends during cooldown', () => {
  const storage = memoryStorage({ [PROFILE_KEY]: JSON.stringify({
    sessions: 12, bestScore: 90, streak: 4, scoreHistory: [], credentials: [], lastSessionDay: '',
    weekly: { weekKey: isoWeekKey(), engage: 20, contribute: 99, collaborate: 50 },
  }) });
  const ui = setup({ storage });
  assert.equal(ui.get('qFocusSessions').textContent, '12');
  assert.equal(ui.get('qRingEngage').styles.get('--ring-progress'), '1');
  assert.equal(ui.get('qRingContribute').styles.get('--ring-progress'), '1');
  assert.equal(ui.get('qRingCollaborate').styles.get('--ring-progress'), '1');
  assert.equal(ui.get('qRingEngageValue').textContent, '20/5');
  ui.controller.updateFocus({ sessionId: 'meeting-1', energy: 90, history: [62, 90] });
  assert.equal(ui.get('qFocusValue').textContent, '90');
  assert.equal(ui.get('qFocusCompactValue').textContent, '90');
  assert.equal(ui.get('qFocusStateLabel').textContent, 'In flow together');
  assert.equal(ui.get('qFocusEnergy').styles.get('--focus-level'), '0.9');
  ui.get('qFocusChargeBtn').dispatch('click');
  ui.get('qFocusChargeBtn').dispatch('click');
  assert.deepEqual(ui.sent, [{ type: 'focus:channel' }]);
  ui.ctx.joined = false;
  ui.controller.setConnection(false);
  ui.get('qFocusParticipateBtn').dispatch('click');
  assert.equal(ui.sent.length, 1);
  assert.equal(ui.get('qFocusStateLabel').textContent, 'Connection paused');
  assert.equal(ui.intervals.size, 0);
});

test('leaving waits for authoritative summary, records once, and stops live timers', () => {
  const ui = setup();
  assert.equal(ui.intervals.size, 1);
  ui.controller.requestLeave();
  ui.controller.requestLeave();
  assert.deepEqual(ui.sent, [{ type: 'leave' }]);
  assert.equal(ui.controller.isEnding(), true);
  assert.equal(ui.get('qLeaveBtn').disabled, true);
  ui.controller.receiveSummary({ sessionId: 'meeting-1', score: 84, avgEnergy: 77, syncsWon: 2, contributions: 6, collaborations: 4 });
  assert.equal(ui.leaveCount(), 1);
  assert.equal(ui.controller.isEnding(), false);
  assert.equal(ui.intervals.size, 0);
  assert.equal(ui.timeouts.size, 0);
  assert.equal(ui.get('qScoreDialog').open, true);
  assert.equal(ui.get('qScoreValue').textContent, '84');
  assert.equal(ui.get('qScoreGrade').textContent, 'A−');
  assert.equal(ui.get('qScoreContributions').textContent, '6');
  assert.equal(JSON.parse(ui.storage.getItem(PROFILE_KEY)).sessions, 1);
  ui.controller.receiveSummary({ sessionId: 'meeting-1', score: 84 });
  assert.equal(JSON.parse(ui.storage.getItem(PROFILE_KEY)).sessions, 1);
  ui.get('qScoreReturnBtn').dispatch('click');
  assert.equal(ui.get('qScoreDialog').open, false);
  assert.equal(ui.doc.activeElement, ui.get('qName'));
});

test('leave timeout uses last known energy and personal counters, and host can end for everyone', () => {
  const ui = setup();
  ui.controller.requestLeave(true);
  assert.deepEqual(ui.sent, [{ type: 'focus:end' }]);
  ui.runTimeouts();
  assert.equal(ui.leaveCount(), 1);
  assert.equal(ui.get('qScoreAvgEnergy').textContent, '62');
  assert.equal(ui.get('qScoreValue').textContent, '49');
  const profile = JSON.parse(ui.storage.getItem(PROFILE_KEY));
  assert.equal(profile.weekly.contribute, 2);
  assert.equal(profile.weekly.collaborate, 1);
  assert.equal(profile.sessions, 1);
});

test('offline session recap includes the last synchronized checklist progress', () => {
  const ui = setup();
  ui.controller.updateFocus({ sessionId: 'tasks-meeting', energy: 62, history: [62, 62], itemsCompleted: 1, itemsTotal: 1 });
  ui.controller.requestLeave();
  ui.runTimeouts();
  assert.equal(ui.get('qScoreValue').textContent, '64');
});
