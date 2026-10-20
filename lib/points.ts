export const SESSION_PROFILE_KEY = 'velos.profile.v1';
export const WEEKLY_GOALS = Object.freeze({ engage: 5, contribute: 40, collaborate: 12 });

export interface SessionScoreInputs {
  avgEnergy?: number;
  missionFrac?: number;
  bestChain?: number;
  syncsWon?: number;
  drifts?: number;
}

export type SessionGrade = 'A' | 'A−' | 'B+' | 'B' | 'C+' | 'C';
export type ProfileDate = Date | string | number;

export interface WeeklyProgress {
  weekKey: string;
  engage: number;
  contribute: number;
  collaborate: number;
}

export interface UserProfile {
  sessions: number;
  bestScore: number;
  streak: number;
  lastSessionDay: string;
  scoreHistory: number[];
  weekly: WeeklyProgress;
  credentials: string[];
}

export interface SessionResult {
  score: number;
  contributions?: number;
  collaborations?: number;
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function count(value: unknown): number {
  return Math.floor(clamp(finite(value), 0, Number.MAX_SAFE_INTEGER));
}

function score(value: unknown): number {
  return Math.round(clamp(finite(value), 0, 100));
}

function dateValue(value: ProfileDate = new Date()): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Local calendar day: a session crossing midnight belongs to the day it ends. */
export function sessionDay(value: ProfileDate = new Date()): string {
  const date = dateValue(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** ISO weeks use the year containing the week's Thursday, including at New Year. */
export function isoWeekKey(value: ProfileDate = new Date()): string {
  const date = dateValue(value);
  const thursday = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const weekYear = thursday.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil((((thursday.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
}

export function computeSessionScore(inputs: SessionScoreInputs = {}): number {
  const avgEnergy = clamp(finite(inputs.avgEnergy), 0, 100);
  const missionFrac = clamp(finite(inputs.missionFrac), 0, 1);
  const bestChain = Math.max(0, finite(inputs.bestChain));
  const syncsWon = Math.max(0, finite(inputs.syncsWon));
  const drifts = Math.max(0, finite(inputs.drifts));
  return Math.round(clamp(
    30
      + 0.3 * avgEnergy
      + 15 * missionFrac
      + 12 * (Math.min(bestChain, 6) / 6)
      + 8 * (Math.min(syncsWon, 3) / 3)
      + 5 * (syncsWon > 0 ? 1 : 0)
      - Math.min(2.5 * drifts, 16),
    0, 100,
  ));
}

export function gradeForScore(value: number): SessionGrade {
  const normalized = finite(value);
  if (normalized >= 90) return 'A';
  if (normalized >= 80) return 'A−';
  if (normalized >= 70) return 'B+';
  if (normalized >= 60) return 'B';
  if (normalized >= 50) return 'C+';
  return 'C';
}

export function initProfile(date: ProfileDate = new Date()): UserProfile {
  return {
    sessions: 0,
    bestScore: 0,
    streak: 0,
    lastSessionDay: '',
    scoreHistory: [],
    weekly: { weekKey: isoWeekKey(date), engage: 0, contribute: 0, collaborate: 0 },
    credentials: [],
  };
}

function validSessionDay(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(year, month - 1, day, 12);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day ? value : '';
}

/** Normalize untrusted parsed storage; persistence remains the host app's responsibility. */
export function normalizeProfile(value: unknown, date: ProfileDate = new Date()): UserProfile {
  const source = object(value);
  const weekly = object(source.weekly);
  const weekKey = isoWeekKey(date);
  const sameWeek = weekly.weekKey === weekKey;
  return {
    sessions: count(source.sessions),
    bestScore: score(source.bestScore),
    streak: count(source.streak),
    lastSessionDay: validSessionDay(source.lastSessionDay),
    scoreHistory: Array.isArray(source.scoreHistory)
      ? source.scoreHistory.filter((value) => typeof value === 'number' && Number.isFinite(value)).slice(-30).map(score)
      : [],
    weekly: {
      weekKey,
      engage: sameWeek ? count(weekly.engage) : 0,
      contribute: sameWeek ? count(weekly.contribute) : 0,
      collaborate: sameWeek ? count(weekly.collaborate) : 0,
    },
    credentials: Array.isArray(source.credentials)
      ? [...new Set(source.credentials.filter((value): value is string => typeof value === 'string' && value.length > 0))]
      : [],
  };
}

export function recordSession(value: unknown, result: SessionResult, date: ProfileDate = new Date()): UserProfile {
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
      collaborate: count(profile.weekly.collaborate + count(result.collaborations)),
    },
    credentials: [...profile.credentials],
  };
}
