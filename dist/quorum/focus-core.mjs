// Generated from lib/*.ts. Run npm run build:core to regenerate.

// lib/focus.ts
var START_ENERGY = 62;
var DECAY_PER_SECOND = 0.9;
var ENERGY_FLOOR = 8;
var ENERGY_CAP = 100;
var SAMPLE_INTERVAL_MS = 500;
var HISTORY_LIMIT = 160;
var FOCUS_EVENT_GAINS = Object.freeze({
  participate: 6,
  channel: 12,
  backchannel: 3,
  close: 5,
  full_alignment: 16,
  partial_alignment: 6,
  drift: -6
});
function clampEnergy(value) {
  return Math.max(ENERGY_FLOOR, Math.min(ENERGY_CAP, value));
}
function currentEnergy(state) {
  return clampEnergy(Number.isFinite(state.energy) ? state.energy : START_ENERGY);
}
function currentHistory(state) {
  return Array.isArray(state.history) ? state.history.filter(Number.isFinite).slice(-HISTORY_LIMIT).map(clampEnergy) : [];
}
function sampleRemainder(state) {
  return Number.isFinite(state.sampleElapsedMs) && state.sampleElapsedMs >= 0 ? state.sampleElapsedMs % SAMPLE_INTERVAL_MS : 0;
}
function initFocus() {
  return { energy: START_ENERGY, history: [], sampleElapsedMs: 0 };
}
function focusTick(state, dtMs) {
  const energy = currentEnergy(state);
  const history = currentHistory(state);
  const elapsed = sampleRemainder(state);
  const duration = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
  const totalElapsed = elapsed + duration;
  const samples = Math.floor(totalElapsed / SAMPLE_INTERVAL_MS);
  const sampleElapsedMs = totalElapsed % SAMPLE_INTERVAL_MS;
  const samplesToKeep = Math.min(samples, HISTORY_LIMIT);
  const latestSampleAt = duration - sampleElapsedMs;
  const nextHistory = samples >= HISTORY_LIMIT ? [] : history;
  for (let index = 0; index < samplesToKeep; index += 1) {
    const sampleAt = latestSampleAt - (samplesToKeep - index - 1) * SAMPLE_INTERVAL_MS;
    nextHistory.push(clampEnergy(energy - DECAY_PER_SECOND * (sampleAt / 1e3)));
  }
  return {
    energy: clampEnergy(energy - DECAY_PER_SECOND * (duration / 1e3)),
    history: nextHistory.slice(-HISTORY_LIMIT),
    sampleElapsedMs
  };
}
function applyFocusEvent(state, event) {
  const candidate = typeof event === "string" ? Object.prototype.hasOwnProperty.call(FOCUS_EVENT_GAINS, event) ? FOCUS_EVENT_GAINS[event] : 0 : event?.delta;
  const delta = typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
  return {
    energy: clampEnergy(currentEnergy(state) + delta),
    history: currentHistory(state),
    sampleElapsedMs: sampleRemainder(state)
  };
}
function focusAverage(history) {
  const samples = Array.isArray(history) ? history.filter(Number.isFinite) : [];
  return samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : 0;
}

// lib/points.ts
var SESSION_PROFILE_KEY = "velos.profile.v1";
var WEEKLY_GOALS = Object.freeze({ engage: 5, contribute: 40, collaborate: 12 });
function finite(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
function count(value) {
  return Math.floor(clamp(finite(value), 0, Number.MAX_SAFE_INTEGER));
}
function score(value) {
  return Math.round(clamp(finite(value), 0, 100));
}
function dateValue(value = /* @__PURE__ */ new Date()) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : /* @__PURE__ */ new Date();
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function sessionDay(value = /* @__PURE__ */ new Date()) {
  const date = dateValue(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function isoWeekKey(value = /* @__PURE__ */ new Date()) {
  const date = dateValue(value);
  const thursday = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const weekYear = thursday.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 864e5 + 1) / 7);
  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}
function computeSessionScore(inputs = {}) {
  const avgEnergy = clamp(finite(inputs.avgEnergy), 0, 100);
  const missionFrac = clamp(finite(inputs.missionFrac), 0, 1);
  const bestChain = Math.max(0, finite(inputs.bestChain));
  const syncsWon = Math.max(0, finite(inputs.syncsWon));
  const drifts = Math.max(0, finite(inputs.drifts));
  return Math.round(clamp(
    30 + 0.3 * avgEnergy + 15 * missionFrac + 12 * (Math.min(bestChain, 6) / 6) + 8 * (Math.min(syncsWon, 3) / 3) + 5 * (syncsWon > 0 ? 1 : 0) - Math.min(2.5 * drifts, 16),
    0,
    100
  ));
}
function gradeForScore(value) {
  const normalized = finite(value);
  if (normalized >= 90) return "A";
  if (normalized >= 80) return "A\u2212";
  if (normalized >= 70) return "B+";
  if (normalized >= 60) return "B";
  if (normalized >= 50) return "C+";
  return "C";
}
function initProfile(date = /* @__PURE__ */ new Date()) {
  return {
    sessions: 0,
    bestScore: 0,
    streak: 0,
    lastSessionDay: "",
    scoreHistory: [],
    weekly: { weekKey: isoWeekKey(date), engage: 0, contribute: 0, collaborate: 0 },
    credentials: []
  };
}
function validSessionDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(year, month - 1, day, 12);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day ? value : "";
}
function normalizeProfile(value, date = /* @__PURE__ */ new Date()) {
  const source = object(value);
  const weekly = object(source.weekly);
  const weekKey = isoWeekKey(date);
  const sameWeek = weekly.weekKey === weekKey;
  return {
    sessions: count(source.sessions),
    bestScore: score(source.bestScore),
    streak: count(source.streak),
    lastSessionDay: validSessionDay(source.lastSessionDay),
    scoreHistory: Array.isArray(source.scoreHistory) ? source.scoreHistory.filter((value2) => typeof value2 === "number" && Number.isFinite(value2)).slice(-30).map(score) : [],
    weekly: {
      weekKey,
      engage: sameWeek ? count(weekly.engage) : 0,
      contribute: sameWeek ? count(weekly.contribute) : 0,
      collaborate: sameWeek ? count(weekly.collaborate) : 0
    },
    credentials: Array.isArray(source.credentials) ? [...new Set(source.credentials.filter((value2) => typeof value2 === "string" && value2.length > 0))] : []
  };
}
function recordSession(value, result, date = /* @__PURE__ */ new Date()) {
  const profile = normalizeProfile(value, date);
  const today = sessionDay(date);
  const sessionScore = score(result.score);
  return {
    sessions: count(profile.sessions + 1),
    bestScore: Math.max(profile.bestScore, sessionScore),
    streak: count(profile.streak + (profile.lastSessionDay !== today ? 1 : 0)),
    lastSessionDay: today,
    scoreHistory: [...profile.scoreHistory, sessionScore].slice(-30),
    weekly: {
      weekKey: profile.weekly.weekKey,
      engage: count(profile.weekly.engage + 1),
      contribute: count(profile.weekly.contribute + count(result.contributions)),
      collaborate: count(profile.weekly.collaborate + count(result.collaborations))
    },
    credentials: [...profile.credentials]
  };
}
export {
  DECAY_PER_SECOND,
  ENERGY_CAP,
  ENERGY_FLOOR,
  FOCUS_EVENT_GAINS,
  HISTORY_LIMIT,
  SAMPLE_INTERVAL_MS,
  SESSION_PROFILE_KEY,
  START_ENERGY,
  WEEKLY_GOALS,
  applyFocusEvent,
  computeSessionScore,
  focusAverage,
  focusTick,
  gradeForScore,
  initFocus,
  initProfile,
  isoWeekKey,
  normalizeProfile,
  recordSession,
  sessionDay
};
