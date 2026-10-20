export const START_ENERGY = 62;
export const DECAY_PER_SECOND = 0.9;
export const ENERGY_FLOOR = 8;
export const ENERGY_CAP = 100;
export const SAMPLE_INTERVAL_MS = 500;
export const HISTORY_LIMIT = 160;

export const FOCUS_EVENT_GAINS = Object.freeze({
  participate: 6,
  channel: 12,
  backchannel: 3,
  close: 5,
  full_alignment: 16,
  partial_alignment: 6,
  drift: -6,
});

export type FocusEventKey = keyof typeof FOCUS_EVENT_GAINS;
export type FocusEvent = FocusEventKey | { delta: number };

export interface FocusState {
  energy: number;
  history: number[];
  /** Time since the previous sample, so uneven render or server ticks stay accurate. */
  sampleElapsedMs: number;
}

function clampEnergy(value: number): number {
  return Math.max(ENERGY_FLOOR, Math.min(ENERGY_CAP, value));
}

function currentEnergy(state: FocusState): number {
  return clampEnergy(Number.isFinite(state.energy) ? state.energy : START_ENERGY);
}

function currentHistory(state: FocusState): number[] {
  return Array.isArray(state.history)
    ? state.history.filter(Number.isFinite).slice(-HISTORY_LIMIT).map(clampEnergy)
    : [];
}

function sampleRemainder(state: FocusState): number {
  return Number.isFinite(state.sampleElapsedMs) && state.sampleElapsedMs >= 0
    ? state.sampleElapsedMs % SAMPLE_INTERVAL_MS
    : 0;
}

export function initFocus(): FocusState {
  return { energy: START_ENERGY, history: [], sampleElapsedMs: 0 };
}

/** Decay by elapsed time and sample at each 500ms boundary, retaining the last 80s. */
export function focusTick(state: FocusState, dtMs: number): FocusState {
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

  // The loop is bounded even if a suspended browser supplies a very large elapsed time.
  for (let index = 0; index < samplesToKeep; index += 1) {
    const sampleAt = latestSampleAt - (samplesToKeep - index - 1) * SAMPLE_INTERVAL_MS;
    nextHistory.push(clampEnergy(energy - DECAY_PER_SECOND * (sampleAt / 1000)));
  }

  return {
    energy: clampEnergy(energy - DECAY_PER_SECOND * (duration / 1000)),
    history: nextHistory.slice(-HISTORY_LIMIT),
    sampleElapsedMs,
  };
}

export function applyFocusEvent(state: FocusState, event: FocusEvent): FocusState {
  const candidate = typeof event === 'string'
    ? (Object.prototype.hasOwnProperty.call(FOCUS_EVENT_GAINS, event) ? FOCUS_EVENT_GAINS[event] : 0)
    : event?.delta;
  const delta = typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : 0;
  return {
    energy: clampEnergy(currentEnergy(state) + delta),
    history: currentHistory(state),
    sampleElapsedMs: sampleRemainder(state),
  };
}

export function focusAverage(history: readonly number[]): number {
  const samples = Array.isArray(history) ? history.filter(Number.isFinite) : [];
  return samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : 0;
}
