import {
  SESSION_PROFILE_KEY, WEEKLY_GOALS, normalizeProfile, recordSession,
  computeSessionScore, gradeForScore, focusAverage
} from './focus-core.mjs';

const LEDGER_KEY = 'velos.sessions.v1';
const SIDEBAR_KEY = 'velos.quorum.sidebar.v1';
const number = (value, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const bound = (value, low, high) => Math.max(low, Math.min(high, number(value, low)));
const parsed = (storage, key, fallback) => {
  try { return JSON.parse(storage?.getItem(key) || 'null') ?? fallback; } catch (_) { return fallback; }
};

/** Storage stays outside the pure scoring module. A meeting is credited once. */
export function createSessionRecorder(storage, now = () => new Date()) {
  let profile = normalizeProfile(parsed(storage, SESSION_PROFILE_KEY, {}), now());
  const storedLedger = parsed(storage, LEDGER_KEY, []);
  const seen = new Set(Array.isArray(storedLedger) ? storedLedger.filter((id) => typeof id === 'string').slice(-120) : []);
  return {
    read() { profile = normalizeProfile(parsed(storage, SESSION_PROFILE_KEY, profile), now()); return profile; },
    record(summary) {
      const sessionId = typeof summary?.sessionId === 'string' ? summary.sessionId : '';
      if (!sessionId) return { profile, recorded: false, saved: false };
      const ledger = parsed(storage, LEDGER_KEY, []);
      if (Array.isArray(ledger)) ledger.forEach((id) => { if (typeof id === 'string') seen.add(id); });
      if (seen.has(sessionId)) return { profile: this.read(), recorded: false, saved: Array.isArray(ledger) && ledger.includes(sessionId) };
      profile = recordSession(this.read(), {
        score: summary.score,
        contributions: summary.contributions,
        collaborations: summary.collaborations
      }, now());
      seen.add(sessionId);
      let saved = false;
      try {
        storage.setItem(SESSION_PROFILE_KEY, JSON.stringify(profile));
        storage.setItem(LEDGER_KEY, JSON.stringify([...seen].slice(-120)));
        saved = true;
      } catch (_) { /* This session still works when browser storage is blocked. */ }
      return { profile, recorded: true, saved };
    }
  };
}

export function focusWavePath(history, energy, width = 260, height = 64) {
  const samples = Array.isArray(history) ? history.filter(Number.isFinite).slice(-160) : [];
  const values = samples.length > 1 ? samples : [samples[0] ?? energy, samples[0] ?? energy];
  const line = values.map((value, index) => `${index ? 'L' : 'M'}${(index / (values.length - 1) * width).toFixed(2)},${(height - 6 - bound(value, 0, 100) / 100 * (height - 12)).toFixed(2)}`).join(' ');
  return { line, area: `${line} L${width},${height} L0,${height} Z` };
}

export function createFocusUI(bridge, {
  document: doc = document, window: win = window,
  storage = (() => { try { return win.localStorage; } catch (_) { return null; } })()
} = {}) {
  const get = (id) => doc.getElementById(id);
  const text = (id, value) => { const element = get(id); if (element) element.textContent = String(value); };
  const show = (id, visible) => { const element = get(id); if (element) element.hidden = !visible; };
  const context = () => bridge.read();
  const recorder = createSessionRecorder(storage);
  let focus = null;
  let ticker = null;
  let ending = false;
  let endTimer = null;
  let lastSummary = null;
  const cooldowns = new Map();
  const mobile = win.matchMedia?.('(max-width: 860px)');
  const meet = get('qMeet');
  const sidebar = get('qFacil');
  let sidebarClosed = parsed(storage, SIDEBAR_KEY, null);
  if (typeof sidebarClosed !== 'boolean') sidebarClosed = !!mobile?.matches;

  function renderProfile(profile = recorder.read()) {
    text('qFocusSessions', profile.sessions);
    text('qFocusStreak', profile.streak);
    text('qFocusBestScore', profile.sessions ? profile.bestScore : '—');
    for (const [key, label] of [['engage', 'Engage'], ['contribute', 'Contribute'], ['collaborate', 'Collaborate']]) {
      const value = profile.weekly[key];
      const ratio = Math.min(1, value / WEEKLY_GOALS[key]);
      const ring = get(`qRing${label}`);
      ring?.style.setProperty('--ring-progress', String(ratio));
      ring?.setAttribute('aria-label', `${label}: ${value} of ${WEEKLY_GOALS[key]}`);
      text(`qRing${label}Value`, `${value}/${WEEKLY_GOALS[key]}`);
    }
  }

  function renderAlignment() {
    const ctx = context();
    const alignment = focus?.alignment;
    const eligible = alignment?.participantIds?.includes(ctx.selfId);
    const joined = alignment?.joinedIds?.includes(ctx.selfId);
    const count = alignment?.joinedIds?.length || 0;
    const total = alignment?.participantIds?.length || 0;
    show('qFocusSyncBtn', !!ctx.isHost && !alignment);
    show('qFocusSyncJoinBtn', !!alignment && !!eligible);
    show('qFocusSyncProgress', !!alignment);
    const startButton = get('qFocusSyncBtn');
    if (startButton) {
      const wait = Math.max(0, number(focus?.nextAlignmentInMs));
      startButton.disabled = !ctx.joined || ending || focus?.canStartAlignment === false || (cooldowns.get('qFocusSyncBtn') || 0) > Date.now();
      startButton.textContent = wait > 0 ? `Ready in ${Math.ceil(wait / 1000)}s` : 'Start alignment';
      startButton.title = wait > 0 ? 'Give the room a moment before the next alignment' : focus?.canStartAlignment === false ? 'Invite at least one other person to align together' : 'Give everyone 10 seconds to join a group alignment';
    }
    const joinButton = get('qFocusSyncJoinBtn');
    if (joinButton) { joinButton.disabled = !!joined || !ctx.joined || ending; joinButton.textContent = joined ? 'You’re aligned ✓' : 'Join alignment'; }
    if (alignment) {
      const seconds = Math.max(0, Math.ceil((alignment.endsAt - Date.now()) / 1000));
      text('qFocusSyncLabel', `${count} of ${total} aligned · ${seconds}s left`);
      const progress = get('qFocusSyncProgress');
      if (progress) { progress.max = Math.max(1, total); progress.value = count; }
    } else {
      text('qFocusSyncLabel', focus?.lastEvent?.key === 'full_alignment'
        ? 'Everyone aligned. +16 room energy.'
        : focus?.lastEvent?.key === 'partial_alignment'
          ? 'A shared moment. +6 room energy.'
          : 'A 10-second moment to align together.');
    }
  }

  function renderFocus() {
    const energy = bound(focus?.energy ?? 62, 8, 100);
    text('qFocusValue', Math.round(energy));
    text('qFocusCompactValue', Math.round(energy));
    const label = !context().joined ? 'Connection paused' : energy >= 80 ? 'In flow together' : energy >= 55 ? 'Building momentum' : energy >= 30 ? 'Finding our rhythm' : 'Time to reconnect';
    text('qFocusStateLabel', label);
    get('qFocusEnergy')?.style.setProperty('--focus-level', String(energy / 100));
    for (const id of ['qFocusMeter', 'qFocusCompactMeter']) {
      get(id)?.setAttribute('aria-valuenow', energy.toFixed(1));
      get(id)?.setAttribute('aria-valuetext', `${Math.round(energy)} out of 100 focus energy`);
    }
    const paths = focusWavePath(focus?.history, energy);
    get('qFocusSparkLine')?.setAttribute('d', paths.line);
    get('qFocusSparkArea')?.setAttribute('d', paths.area);
    const active = !!context().joined && !ending;
    for (const id of ['qFocusChargeBtn', 'qFocusParticipateBtn', 'qFocusSignalBtn', 'qFocusSyncBtn']) {
      const button = get(id);
      if (button) button.disabled = !active || (cooldowns.get(id) || 0) > Date.now();
    }
    for (const id of ['qEndSessionBtn', 'qFocusCompleteBtn', 'qFocusDriftBtn']) show(id, !!context().isHost);
    renderAlignment();
  }

  function setConnection(connected) {
    if (ticker) win.clearInterval(ticker);
    ticker = connected ? win.setInterval(renderFocus, 500) : null;
    renderFocus();
  }

  function updateFocus(next) {
    if (next?.sessionId && focus?.sessionId !== next.sessionId) lastSummary = null;
    focus = next || focus;
    renderFocus();
  }

  function updateRoom(room) {
    if (room?.focus) {
      if (focus?.sessionId !== room.focus.sessionId) lastSummary = null;
      focus = room.focus;
    }
    renderProfile();
    setConnection(!!context().joined);
  }

  function setSidebar(closed, persist = true) {
    sidebarClosed = !!closed;
    if (sidebarClosed && sidebar?.contains(doc.activeElement)) get('qSidebarToggle')?.focus();
    meet?.classList.toggle('q-sidebar-closed', sidebarClosed);
    if (sidebar) { sidebar.inert = sidebarClosed; sidebar.setAttribute('aria-hidden', String(sidebarClosed)); }
    for (const id of ['qSidebarToggle', 'qSidebarHandle']) {
      get(id)?.setAttribute('aria-expanded', String(!sidebarClosed));
      get(id)?.setAttribute('aria-label', sidebarClosed ? 'Show sidebar' : 'Hide sidebar');
      get(id)?.setAttribute('title', sidebarClosed ? 'Show sidebar' : 'Hide sidebar');
    }
    show('qSidebarBackdrop', !sidebarClosed && !!mobile?.matches);
    if (persist) { try { storage?.setItem(SIDEBAR_KEY, JSON.stringify(sidebarClosed)); } catch (_) {} }
  }

  for (const id of ['qSidebarToggle', 'qSidebarHandle']) get(id)?.addEventListener('click', () => setSidebar(!sidebarClosed));
  get('qSidebarCloseBtn')?.addEventListener('click', () => setSidebar(true));
  get('qSidebarBackdrop')?.addEventListener('click', () => setSidebar(true));
  mobile?.addEventListener?.('change', () => setSidebar(sidebarClosed, false));
  let swipe = null;
  let suppressClickUntil = 0;
  meet?.addEventListener('click', (event) => {
    if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  meet?.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    const handle = get('qSidebarHandle')?.contains(event.target);
    if (!handle && event.target.closest?.('button, a, input, textarea, select, video, [contenteditable="true"]')) return;
    const onPanel = sidebar?.contains(event.target);
    const onEdge = sidebarClosed && event.clientX >= win.innerWidth - 28;
    if (!handle && !onPanel && !onEdge) return;
    swipe = { id: event.pointerId, x: event.clientX, y: event.clientY, closed: sidebarClosed };
  }, true);
  meet?.addEventListener('pointermove', (event) => {
    if (!swipe || swipe.id !== event.pointerId) return;
    if (Math.abs(event.clientX - swipe.x) > Math.abs(event.clientY - swipe.y) * 1.4 && Math.abs(event.clientX - swipe.x) > 18) event.preventDefault();
  }, { passive: false });
  meet?.addEventListener('pointerup', (event) => {
    if (!swipe || swipe.id !== event.pointerId) return;
    const dx = event.clientX - swipe.x;
    const dy = event.clientY - swipe.y;
    if (Math.abs(dx) >= 54 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      if (swipe.closed && dx < 0) { setSidebar(false); suppressClickUntil = Date.now() + 450; }
      else if (!swipe.closed && dx > 0) { setSidebar(true); suppressClickUntil = Date.now() + 450; }
    }
    swipe = null;
  });
  meet?.addEventListener('pointercancel', () => { swipe = null; });
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !get('qScoreDialog')?.open && !sidebarClosed && (mobile?.matches || sidebar?.contains(doc.activeElement))) setSidebar(true);
  });

  function action(id, type) {
    get(id)?.addEventListener('click', () => {
      if (!context().joined || (cooldowns.get(id) || 0) > Date.now()) return;
      if (!bridge.send({ type })) return;
      cooldowns.set(id, Date.now() + 1500);
      renderFocus();
    });
  }
  for (const [id, type] of [
    ['qFocusChargeBtn', 'focus:channel'], ['qFocusParticipateBtn', 'focus:participate'],
    ['qFocusSignalBtn', 'focus:backchannel'], ['qFocusSyncBtn', 'focus:sync-start'],
    ['qFocusSyncJoinBtn', 'focus:sync-join'], ['qFocusCompleteBtn', 'focus:close'], ['qFocusDriftBtn', 'focus:drift']
  ]) action(id, type);

  function stop() {
    if (ticker) win.clearInterval(ticker);
    if (endTimer) win.clearTimeout(endTimer);
    ticker = null;
    endTimer = null;
    ending = false;
    for (const id of ['qLeaveBtn', 'qLeaveBtn2']) { if (get(id)) get(id).disabled = false; }
  }

  function showSummary(summary) {
    const result = recorder.record(summary);
    const profile = result.profile;
    text('qScoreValue', Math.round(bound(summary.score, 0, 100)));
    text('qScoreGrade', gradeForScore(summary.score));
    text('qScoreAvgEnergy', Math.round(bound(summary.avgEnergy, 0, 100)));
    text('qScoreContributions', Math.max(0, Math.floor(number(summary.contributions))));
    text('qScoreSyncs', Math.max(0, Math.floor(number(summary.syncsWon))));
    text('qScoreStreak', profile.streak);
    text('qScoreSessions', profile.sessions);
    text('qScoreBest', profile.bestScore);
    text('qScoreSaved', 'Keep the session notes to carry these next steps forward.');
    const outcomes = summary.outcomes || {};
    text('qdSessionOutcomes', [outcomes.objective ? `Objective: ${outcomes.objective}` : 'No shared objective was recorded.',
      `${number(summary.itemsCompleted)}/${number(summary.itemsTotal)} tasks completed · ${number(outcomes.ballotsClosed)} ballots closed`,
      ...(outcomes.conclusions || []).map(item => `${item.question}\nNext step: ${item.conclusion}`)
    ].join('\n\n'));
    const download = get('qdSummaryDownload');
    if (download) download.onclick = () => {
      const url = win.URL.createObjectURL(new win.Blob([get('qdSessionOutcomes')?.textContent || ''], { type: 'text/plain' }));
      const link = doc.createElement('a'); link.href = url; link.download = 'quorum-session-notes.txt'; link.click();
      win.setTimeout(() => win.URL.revokeObjectURL(url), 1000);
    };
    renderProfile(profile);
    const dialog = get('qScoreDialog');
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
  }

  function fallbackSummary() {
    if (!focus?.sessionId) return null;
    const avgEnergy = focusAverage(focus.history?.length ? focus.history : [focus.energy]);
    return {
      sessionId: focus.sessionId,
      score: computeSessionScore({ avgEnergy, missionFrac: number(focus.itemsTotal) > 0 ? bound(number(focus.itemsCompleted) / focus.itemsTotal, 0, 1) : 0, bestChain: focus.bestChain, syncsWon: focus.syncsWon, drifts: focus.drifts }),
      avgEnergy, syncsWon: focus.syncsWon,
      itemsTotal: focus.itemsTotal, itemsCompleted: focus.itemsCompleted,
      outcomes: { objective: context().room?.decisions?.objective || '',
        ballotsClosed: context().room?.decisions?.ballots?.filter(b => !b.open).length || 0,
        conclusions: (context().room?.decisions?.ballots || []).filter(b => b.conclusion).map(b => ({ question:b.title, conclusion:b.conclusion })) },
      contributions: focus.personal?.contributions || 0,
      collaborations: focus.personal?.collaborations || 0
    };
  }

  function completeLeave(summary = lastSummary || fallbackSummary()) {
    lastSummary = summary;
    stop();
    bridge.leave();
    if (summary) showSummary(summary);
  }

  function receiveSummary(summary) {
    if (!summary?.sessionId) return;
    lastSummary = summary;
    if (ending) completeLeave(summary);
    else { stop(); showSummary(summary); }
  }

  function requestLeave(all = false) {
    if (ending) return;
    ending = true;
    for (const id of ['qLeaveBtn', 'qLeaveBtn2']) { if (get(id)) get(id).disabled = true; }
    renderFocus();
    if (!context().joined || !bridge.send({ type: all ? 'focus:end' : 'leave' })) { completeLeave(); return; }
    endTimer = win.setTimeout(() => completeLeave(), 1800);
  }

  get('qEndSessionBtn')?.addEventListener('click', () => { if (context().isHost) requestLeave(true); });
  function closeSummary() {
    const dialog = get('qScoreDialog');
    if (typeof dialog?.close === 'function') dialog.close();
    else dialog?.removeAttribute('open');
    if (!context().joined) get('qName')?.focus();
  }
  for (const id of ['qScoreCloseBtn', 'qScoreReturnBtn']) get(id)?.addEventListener('click', closeSummary);
  get('qScoreDialog')?.addEventListener('click', (event) => { if (event.target === get('qScoreDialog')) closeSummary(); });
  win.addEventListener('storage', (event) => { if (event.key === SESSION_PROFILE_KEY || event.key === null) renderProfile(); });
  setSidebar(sidebarClosed, false);
  updateRoom(context().room);
  if (context().pendingSummary) receiveSummary(context().pendingSummary);
  return { updateRoom, updateFocus, setConnection, setSidebar, receiveSummary, requestLeave, completeLeave, stop, isEnding: () => ending };
}

if (typeof window !== 'undefined' && window.QuorumFocusBridge) {
  window.QuorumFocusUI = createFocusUI(window.QuorumFocusBridge);
}
