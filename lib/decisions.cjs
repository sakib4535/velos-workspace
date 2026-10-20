'use strict';
const { randomUUID } = require('node:crypto');
const SCALE = ['Yes', 'Somewhat yes', 'Don’t know', 'Somewhat no', 'No'];
const CHECKINS = ['clear', 'context', 'pause'];
const safeText = (s, max) => typeof s === 'string' ? s.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) : '';
function initDecisions() {
  return { ballots: [], objective: '', cohostId: null, round: 0, checkinOpen: false, checkins: new Map(), published: null };
}
function manager(room, id) { return id === room.hostId || id === room.decisions.cohostId; }
function activeIds(room) { return [...room.participants.values()].filter(p => p.ws?.readyState === 1).map(p => p.id); }
function requireThat(ok, message) { if (!ok) throw new Error(message); }
function applyDecision(room, senderId, msg) {
  const d = room.decisions;
  const canManage = manager(room, senderId);
  if (msg.type === 'decision:create') {
    requireThat(d.ballots.length < 20, 'This room holds up to 20 ballots. Start a new meeting for more.');
    requireThat(['topic', 'radar', 'scale'].includes(msg.kind), 'Choose a ballot type.');
    const title = safeText(msg.title, 180);
    requireThat(title, 'Add a question for this ballot.');
    const options = msg.kind === 'scale' ? SCALE : (Array.isArray(msg.options) ? msg.options.map(s => safeText(s, 60)) : []);
    const minimum = msg.kind === 'radar' ? 3 : 2;
    requireThat(options.length >= minimum && options.length <= 6 && options.every(Boolean) && new Set(options.map(x => x.toLowerCase())).size === options.length, `Use ${minimum}–6 distinct, non-empty options.`);
    d.ballots.push({ id: randomUUID(), kind: msg.kind, title, options, multiple: msg.kind === 'topic' && msg.multiple === true,
      createdBy: senderId, createdAt: Date.now(), open: true, eligible: activeIds(room), votes: new Map(), tokens: new Map(), conclusion: '' });
  } else if (msg.type === 'decision:vote') {
    const b = d.ballots.find(b => b.id === msg.id);
    requireThat(b?.open, 'This ballot is closed.');
    requireThat(b.eligible.includes(senderId), 'Voting is reserved for the people present when this ballot opened.');
    if (msg.value === null) { b.votes.delete(senderId); return; }
    const value = msg.value;
    requireThat(Array.isArray(value), 'Choose a valid response.');
    if (b.kind === 'radar') requireThat(value.length === b.options.length && value.every(v => Number.isInteger(v) && v >= 1 && v <= 5), 'Rate each criterion from 1 to 5.');
    else requireThat(value.length >= 1 && value.length <= (b.multiple ? b.options.length : 1) && new Set(value).size === value.length && value.every(v => Number.isInteger(v) && v >= 0 && v < b.options.length), 'Choose valid ballot options.');
    b.votes.set(senderId, [...value]);
    if (!b.tokens.has(senderId)) b.tokens.set(senderId, randomUUID());
  } else if (msg.type === 'decision:close' || msg.type === 'decision:conclusion') {
    const b = d.ballots.find(b => b.id === msg.id);
    requireThat(b && (canManage || b.createdBy === senderId), 'Only the ballot creator or a facilitator can manage this ballot.');
    if (msg.type === 'decision:close') b.open = false;
    else b.conclusion = safeText(msg.conclusion, 600);
  } else if (msg.type === 'thinking:cohost') {
    requireThat(senderId === room.hostId, 'Only the host can choose a co-facilitator.');
    requireThat(msg.id === null || (room.participants.has(msg.id) && msg.id !== room.hostId), 'Choose someone in this room.');
    d.cohostId = msg.id;
  } else if (msg.type === 'thinking:objective') {
    requireThat(canManage, 'Only facilitators can change the shared objective.');
    d.objective = safeText(msg.objective, 240);
  } else if (msg.type === 'thinking:start') {
    requireThat(canManage, 'Only facilitators can open a check-in.');
    requireThat(!d.checkinOpen, 'A check-in is already open.');
    d.round++; d.checkinOpen = true; d.checkins.clear(); d.published = null;
  } else if (msg.type === 'thinking:respond') {
    requireThat(d.checkinOpen && msg.round === d.round, 'This check-in has ended or changed.');
    requireThat(msg.value === null || CHECKINS.includes(msg.value), 'Choose a check-in response.');
    if (msg.value === null) d.checkins.delete(senderId); else d.checkins.set(senderId, msg.value);
  } else if (msg.type === 'thinking:finish') {
    requireThat(canManage && d.checkinOpen, 'Only facilitators can close an open check-in.');
    d.checkinOpen = false;
    const values = [...d.checkins.values()];
    // Publish once as a batch. No live named responses, timestamps or per-person status.
    d.published = values.length >= 3 ? { total: values.length, counts: CHECKINS.map(k => values.filter(v => v === k).length) } : { withheld: true };
    d.checkins.clear();
  } else throw new Error('Unknown decision action.');
}
function decisionSnapshot(room, viewerId) {
  const d = room.decisions;
  return {
    objective: d.objective, cohostId: room.participants.has(d.cohostId) ? d.cohostId : null,
    canManage: manager(room, viewerId), round: d.round, checkinOpen: d.checkinOpen,
    myCheckin: d.checkins.get(viewerId) || null, published: d.published,
    ballots: d.ballots.map(b => {
      const votes = [...b.votes.values()];
      return { id: b.id, kind: b.kind, title: b.title, options: b.options, multiple: b.multiple, open: b.open,
        createdAt: b.createdAt, eligibleCount: b.eligible.length, responded: votes.length,
        canVote: b.open && b.eligible.includes(viewerId), canManage: manager(room, viewerId) || b.createdBy === viewerId,
        mine: b.votes.get(viewerId) || null, conclusion: b.conclusion,
        values: b.options.map((_, i) => b.kind === 'radar' ? (votes.length ? votes.reduce((sum, v) => sum + v[i], 0) / votes.length : 0) : votes.filter(v => v.includes(i)).length),
        bubbles: b.kind === 'topic' ? [...b.votes].map(([id, value]) => ({ token: b.tokens.get(id), choices: value })) : [] };
    })
  };
}
function decisionOutcomes(room) {
  return { objective: room.decisions.objective, ballotsClosed: room.decisions.ballots.filter(b => !b.open).length,
    conclusions: room.decisions.ballots.filter(b => b.conclusion).map(b => ({ question: b.title, conclusion: b.conclusion })) };
}
module.exports = { initDecisions, applyDecision, decisionSnapshot, decisionOutcomes };
