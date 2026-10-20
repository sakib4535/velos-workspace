'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  START_ENERGY,
  DECAY_PER_SECOND,
  ENERGY_FLOOR,
  ENERGY_CAP,
  SAMPLE_INTERVAL_MS,
  HISTORY_LIMIT,
  FOCUS_EVENT_GAINS,
  SESSION_PROFILE_KEY,
  WEEKLY_GOALS,
  initFocus,
  focusTick,
  applyFocusEvent,
  focusAverage,
  computeSessionScore,
  gradeForScore,
  initProfile,
  normalizeProfile,
  recordSession,
  sessionDay,
  isoWeekKey,
} = require('../lib/quorum-core.cjs');

function closeTo(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `Expected ${actual} to be close to ${expected}`);
}

function localDate(year, month, day, hour = 12) {
  return new Date(year, month - 1, day, hour);
}

test('focus tuning and every named event match the meeting contract', () => {
  assert.deepEqual([START_ENERGY, DECAY_PER_SECOND, ENERGY_FLOOR, ENERGY_CAP, SAMPLE_INTERVAL_MS, HISTORY_LIMIT],
    [62, 0.9, 8, 100, 500, 160]);
  assert.deepEqual(FOCUS_EVENT_GAINS, {
    participate: 6, channel: 12, backchannel: 3, close: 5,
    full_alignment: 16, partial_alignment: 6, drift: -6,
  });
  for (const [event, delta] of Object.entries(FOCUS_EVENT_GAINS)) {
    assert.equal(applyFocusEvent(initFocus(), event).energy, 62 + delta);
  }
  assert.equal(applyFocusEvent(initFocus(), { delta: 1000 }).energy, 100);
  assert.equal(applyFocusEvent(initFocus(), { delta: -1000 }).energy, 8);
});

test('focus samples on 500ms boundaries and accounts for uneven elapsed ticks', () => {
  const initial = initFocus();
  const first = focusTick(initial, 125);
  assert.deepEqual(first.history, []);
  closeTo(first.energy, 61.8875);
  assert.equal(first.sampleElapsedMs, 125);
  const second = focusTick(first, 1075);
  closeTo(second.energy, 60.92);
  assert.equal(second.sampleElapsedMs, 200);
  assert.equal(second.history.length, 2);
  closeTo(second.history[0], 61.55);
  closeTo(second.history[1], 61.1);
  const singleTick = focusTick(initial, 1200);
  closeTo(singleTick.energy, second.energy);
  singleTick.history.forEach((value, index) => closeTo(value, second.history[index]));
  assert.deepEqual(initial, { energy: 62, history: [], sampleElapsedMs: 0 });
});

test('focus events between samples preserve the next sample boundary without mutation', () => {
  const initial = focusTick(initFocus(), 250);
  Object.freeze(initial.history);
  Object.freeze(initial);
  const charged = applyFocusEvent(initial, 'channel');
  const sampled = focusTick(charged, 250);
  assert.equal(charged.sampleElapsedMs, 250);
  assert.equal(sampled.sampleElapsedMs, 0);
  assert.equal(sampled.history.length, 1);
  closeTo(sampled.history[0], 73.55);
  assert.equal(initial.history.length, 0);
  assert.notEqual(initial.history, charged.history);
});

test('focus retains the most recent 80 seconds and stays bounded after suspended ticks', () => {
  const sampled = focusTick(initFocus(), 80000);
  assert.equal(sampled.history.length, 160);
  closeTo(sampled.history[0], 61.55);
  assert.equal(sampled.energy, 8);
  const next = focusTick(sampled, 500);
  assert.equal(next.history.length, 160);
  closeTo(next.history[0], 61.1);
  assert.equal(next.history.at(-1), 8);
  const suspended = focusTick(initFocus(), Number.MAX_VALUE);
  assert.equal(suspended.history.length, 160);
  assert.ok(suspended.history.every((value) => value === 8));
  assert.equal(suspended.energy, 8);
});

test('focus rejects invalid elapsed time and deltas and computes a finite average', () => {
  const state = focusTick(initFocus(), 500);
  for (const duration of [NaN, Infinity, -Infinity, -10]) {
    assert.deepEqual(focusTick(state, duration), state);
  }
  for (const event of [{ delta: NaN }, { delta: Infinity }, 'unknown', '__proto__']) {
    assert.deepEqual(applyFocusEvent(state, event), state);
  }
  assert.equal(focusAverage([]), 0);
  assert.equal(focusAverage([8, 62, 100]), 170 / 3);
  assert.equal(focusAverage([NaN, 20, Infinity, 40]), 30);
});

test('session score applies the complete formula, caps, and rounding', () => {
  assert.equal(computeSessionScore(), 30);
  assert.equal(computeSessionScore({ avgEnergy: 100, missionFrac: 1, bestChain: 6, syncsWon: 3, drifts: 0 }), 100);
  assert.equal(computeSessionScore({ avgEnergy: 62, missionFrac: 0.5, bestChain: 3, syncsWon: 1, drifts: 2 }), 65);
  assert.equal(computeSessionScore({ drifts: 1000 }), 14);
  assert.equal(computeSessionScore({ bestChain: 60, syncsWon: 30 }), 55);
  assert.equal(computeSessionScore({ avgEnergy: NaN, missionFrac: -1, bestChain: Infinity, syncsWon: -2, drifts: -3 }), 30);
  assert.equal(computeSessionScore({ avgEnergy: 999, missionFrac: 2, bestChain: 100, syncsWon: 9 }), 100);
});

test('session grades use the exact score thresholds', () => {
  for (const [value, grade] of [[100, 'A'], [90, 'A'], [89, 'A−'], [80, 'A−'], [79, 'B+'], [70, 'B+'],
    [69, 'B'], [60, 'B'], [59, 'C+'], [50, 'C+'], [49, 'C'], [0, 'C']]) {
    assert.equal(gradeForScore(value), grade);
  }
});

test('profile defaults, storage key, weekly goals, local days, and ISO week-year boundaries', () => {
  assert.equal(SESSION_PROFILE_KEY, 'velos.profile.v1');
  assert.deepEqual(WEEKLY_GOALS, { engage: 5, contribute: 40, collaborate: 12 });
  assert.equal(sessionDay(localDate(2026, 10, 19)), '2026-10-19');
  assert.equal(isoWeekKey(localDate(2021, 1, 1)), '2020-W53');
  assert.equal(isoWeekKey(localDate(2021, 1, 4)), '2021-W01');
  assert.equal(isoWeekKey(localDate(2024, 12, 30)), '2025-W01');
  assert.equal(isoWeekKey(localDate(2026, 10, 19)), '2026-W43');
  assert.deepEqual(initProfile(localDate(2026, 10, 19)), {
    sessions: 0, bestScore: 0, streak: 0, lastSessionDay: '', scoreHistory: [],
    weekly: { weekKey: '2026-W43', engage: 0, contribute: 0, collaborate: 0 }, credentials: [],
  });
});

test('recording sessions increments a streak only once on each new local day', () => {
  const today = localDate(2026, 10, 19);
  const initial = initProfile(today);
  Object.freeze(initial.scoreHistory);
  Object.freeze(initial.weekly);
  Object.freeze(initial.credentials);
  Object.freeze(initial);
  const first = recordSession(initial, { score: 80, contributions: 3, collaborations: 2 }, today);
  assert.equal(first.sessions, 1);
  assert.equal(first.streak, 1);
  assert.equal(first.bestScore, 80);
  assert.deepEqual(first.scoreHistory, [80]);
  assert.deepEqual(first.weekly, { weekKey: '2026-W43', engage: 1, contribute: 3, collaborate: 2 });
  const sameDay = recordSession(first, { score: 75 }, localDate(2026, 10, 19, 23));
  assert.equal(sameDay.sessions, 2);
  assert.equal(sameDay.streak, 1);
  assert.equal(sameDay.bestScore, 80);
  const nextDay = recordSession(sameDay, { score: 90 }, localDate(2026, 10, 20));
  assert.equal(nextDay.streak, 2);
  assert.equal(nextDay.lastSessionDay, '2026-10-20');
  // The specified rule increments for a new session day even after a skipped day.
  const laterDay = recordSession(nextDay, { score: 60 }, localDate(2026, 10, 23));
  assert.equal(laterDay.streak, 3);
  assert.equal(initial.sessions, 0);
});

test('weekly progress resets on week change while profile history retains the last 30 sessions', () => {
  let profile = initProfile(localDate(2026, 10, 18));
  for (let index = 0; index < 35; index += 1) {
    profile = recordSession(profile, { score: index, contributions: 2, collaborations: 1 }, localDate(2026, 10, 18));
  }
  assert.equal(profile.sessions, 35);
  assert.equal(profile.streak, 1);
  assert.deepEqual(profile.scoreHistory, Array.from({ length: 30 }, (_, index) => index + 5));
  assert.deepEqual(profile.weekly, { weekKey: '2026-W42', engage: 35, contribute: 70, collaborate: 35 });
  const newWeek = recordSession(profile, { score: 90, contributions: 4, collaborations: 3 }, localDate(2026, 10, 19));
  assert.equal(newWeek.sessions, 36);
  assert.equal(newWeek.bestScore, 90);
  assert.equal(newWeek.scoreHistory.length, 30);
  assert.deepEqual(newWeek.weekly, { weekKey: '2026-W43', engage: 1, contribute: 4, collaborate: 3 });
  assert.deepEqual(normalizeProfile(profile, localDate(2026, 10, 19)).weekly,
    { weekKey: '2026-W43', engage: 0, contribute: 0, collaborate: 0 });
});

test('malformed stored profiles normalize safely without mutating the parsed value', () => {
  const today = localDate(2026, 10, 19);
  assert.deepEqual(normalizeProfile(null, today), initProfile(today));
  assert.deepEqual(normalizeProfile('broken storage', today), initProfile(today));
  const stored = {
    sessions: -2, bestScore: 300, streak: 2.8, lastSessionDay: '2026-02-30',
    scoreHistory: [20, NaN, 101, -10, '50'],
    weekly: { weekKey: '2026-W43', engage: 2.8, contribute: -4, collaborate: Infinity },
    credentials: ['first-session', 'first-session', 42, ''],
  };
  const normalized = normalizeProfile(stored, today);
  assert.deepEqual(normalized, {
    sessions: 0, bestScore: 100, streak: 2, lastSessionDay: '', scoreHistory: [20, 100, 0],
    weekly: { weekKey: '2026-W43', engage: 2, contribute: 0, collaborate: 0 }, credentials: ['first-session'],
  });
  assert.equal(stored.scoreHistory.length, 5);
  assert.equal(stored.weekly.engage, 2.8);
});
