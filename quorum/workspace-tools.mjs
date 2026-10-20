const WORLD = { width: 1600, height: 1000 };
export const TOOL_DEFAULTS = Object.freeze({
  notes: { title: 'Shared notes', w: .275, h: .34 },
  board: { title: 'Drawing board', w: .35, h: .4 },
  tasks: { title: 'Team checklist', w: .275, h: .34 },
  timer: { title: 'Focus timer', w: .275, h: .34 },
  embed: { title: 'Web channel', w: .4, h: .42 },
});
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = value => JSON.parse(JSON.stringify(value));
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function screenPlacement(center, kind, room = {}) {
  const size = TOOL_DEFAULTS[kind] || TOOL_DEFAULTS.notes;
  const obstacles = [
    ...(room.tools || []).map(tool => ({ x: tool.x, y: tool.y, w: tool.w, h: tool.h })),
    ...(room.participants || []).map(person => ({ x: person.box?.x - .085, y: person.box?.y - .092, w: .17, h: .184 })),
  ].filter(rect => [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite));
  const free = candidate => obstacles.every(rect => candidate.x + size.w + .025 <= rect.x || candidate.x >= rect.x + rect.w + .025 || candidate.y + size.h + .025 <= rect.y || candidate.y >= rect.y + rect.h + .025);
  const candidates = [
    { x: center.x + .12, y: center.y - size.h / 2 },
    { x: center.x - size.w - .12, y: center.y - size.h / 2 },
    { x: center.x - size.w / 2, y: center.y + .13 },
    { x: center.x - size.w / 2, y: center.y - size.h - .13 },
  ];
  for (let ring = 1; ring <= 6; ring += 1) {
    for (let column = -ring; column <= ring; column += 1) {
      for (let row = -ring; row <= ring; row += 1) {
        if (Math.max(Math.abs(column), Math.abs(row)) !== ring) continue;
        candidates.push({ x: center.x - size.w / 2 + column * (size.w + .035), y: center.y - size.h / 2 + row * (size.h + .04) });
      }
    }
  }
  return candidates.find(free) || candidates.at(-1);
}

/** A remote document keeps its own origin; never grant our application origin to an embedded page. */
export function normalizeEmbedUrl(value, ownOrigin = '') {
  let url;
  if (String(value).length > 2048) throw new Error('This embed URL is too long. Use the provider’s direct embed link.');
  try { url = new URL(String(value).trim()); } catch { throw new Error('Enter a complete HTTPS embed URL.'); }
  const host = url.hostname.toLowerCase();
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(host);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('Use HTTPS, or a local development tool on localhost.');
  if (url.username || url.password) throw new Error('Remove usernames and passwords from the URL.');
  if (ownOrigin && url.origin === ownOrigin) throw new Error('Use an external embed URL. Quorum cannot embed its own application.');
  if (!local && (!host.includes('.') || /(?:^|\.)(?:local|internal|localhost|test|invalid)$/.test(host) || /^0\./.test(host) || /^127\./.test(host) || /^10\./.test(host) || /^192\.(168|0)\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) || /^(22[4-9]|2[3-5]\d)\./.test(host) || host.startsWith('['))) throw new Error('Use a public HTTPS address.');
  return url.href;
}

export function timerRemaining(data, now = Date.now()) {
  const duration = Math.max(0, Number(data?.durationMs) || 0);
  if (!data?.running || !Number.isFinite(data.startedAt)) return duration;
  return Math.max(0, duration - Math.max(0, now - data.startedAt));
}

export function formatTimer(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

export function exportToolDocument(tool, data = tool.data) {
  const stem = String(tool.title || tool.kind).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 70) || 'Quorum screen';
  if (tool.kind === 'notes') return { filename: `${stem}.txt`, mime: 'text/plain;charset=utf-8', content: data.text || '' };
  if (tool.kind === 'tasks') return { filename: `${stem}.md`, mime: 'text/markdown;charset=utf-8', content: `# ${tool.title}\n\n${(data.items || []).map(item => `- [${item.done ? 'x' : ' '}] ${item.text}`).join('\n')}\n` };
  if (tool.kind === 'board') {
    const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
    const strokes = (data.strokes || []).map(stroke => {
      const color = /^#[a-fA-F0-9]{6}$/.test(stroke.color) ? stroke.color : '#66dfbd';
      const width = clamp(Number(stroke.width) || 4, 1, 20);
      const points = stroke.points.map(point => `${clamp(Number(point.x) || 0, 0, 1) * 1000},${clamp(Number(point.y) || 0, 0, 1) * 600}`).join(' ');
      if (stroke.points.length === 1) return `<circle cx="${clamp(Number(stroke.points[0].x) || 0, 0, 1) * 1000}" cy="${clamp(Number(stroke.points[0].y) || 0, 0, 1) * 600}" r="${width / 2}" fill="${color}"/>`;
      return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }).join('\n');
    return { filename: `${stem}.svg`, mime: 'image/svg+xml;charset=utf-8', content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 600"><title>${escape(tool.title)}</title><rect width="1000" height="600" fill="#0b1215"/>${strokes}</svg>` };
  }
  return { filename: `${stem}.json`, mime: 'application/json;charset=utf-8', content: JSON.stringify({ title: tool.title, kind: tool.kind, data }, null, 2) };
}

/** Accept acknowledgements and harmless layout changes; retain a concurrent local edit for review. */
export function reconcileDraft(draft, incoming) {
  if (!draft) return { status: 'clean', draft: null };
  if (draft.pendingData && equal(incoming.data, draft.pendingData)) {
    if (equal(draft.data, draft.pendingData)) return { status: 'clean', draft: null };
    return { status: 'dirty', draft: { ...draft, baseData: clone(incoming.data), baseVersion: incoming.version, pendingData: null } };
  }
  if (equal(incoming.data, draft.baseData)) {
    return { status: draft.pendingData ? 'waiting' : 'dirty', draft: { ...draft, baseVersion: incoming.version } };
  }
  return { status: 'conflict', draft: { ...draft, pendingData: null } };
}

export function createWorkspaceUI(bridge, { document: doc = document, window: win = window } = {}) {
  const container = doc.getElementById('qToolScreens');
  if (!container) return { updateRoom() {}, reset() {}, handleConflict() {}, handleError() {} };
  const records = new Map();
  let frontOrder = 0;
  const dialog = doc.getElementById('qToolsDialog');
  const status = doc.getElementById('qToolCreateStatus');
  let timer = null;
  let awaitingCreate = null;

  function element(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(label, title, callback, className = 'q-tool-button') {
    const node = element('button', className, label);
    node.type = 'button'; node.title = title; node.setAttribute('aria-label', title);
    node.addEventListener('click', callback);
    return node;
  }
  function announce(message, error = false) {
    if (status) { status.textContent = message; status.classList.toggle('is-error', error); }
  }
  function send(payload) {
    if (!bridge.read().joined) { announce('Join a room before adding a screen.', true); return false; }
    return bridge.send(payload) !== false;
  }
  function place(record, geometry = record.tool) {
    if (record.moving && geometry === record.tool) return;
    Object.assign(record.node.style, { left: `${geometry.x * WORLD.width}px`, top: `${geometry.y * WORLD.height}px`, width: `${geometry.w * WORLD.width}px`, height: `${geometry.h * WORLD.height}px` });
  }
  function setSaveStatus(record, message, problem = false) {
    record.save.textContent = message;
    record.save.classList.toggle('is-error', problem);
  }
  function scheduleSave(record) {
    clearTimeout(record.debounce);
    if (record.conflict || record.saveBlocked || record.orphan || record.draft?.pendingData) return;
    record.debounce = setTimeout(() => flush(record), 280);
  }
  function flush(record) {
    if (!record.draft || record.conflict || record.saveBlocked || record.draft.pendingData || record.orphan) return;
    record.draft.pendingData = clone(record.draft.data);
    setSaveStatus(record, 'Saving…');
    if (!send({ type: 'workspace:update', id: record.tool.id, data: record.draft.data, baseVersion: record.draft.baseVersion })) {
      record.draft.pendingData = null;
      setSaveStatus(record, 'Offline · draft kept here', true);
    }
  }
  function queueData(record, data) {
    record.draft ||= { baseData: clone(record.tool.data), baseVersion: record.tool.version, data, pendingData: null };
    record.draft.data = clone(data);
    if (record.orphan) { setSaveStatus(record, 'Removed from room · download your draft before closing', true); return; }
    record.saveBlocked = false;
    setSaveStatus(record, record.conflict ? 'Room changed · review your draft' : 'Unsaved changes', !!record.conflict);
    scheduleSave(record);
  }
  function dataOf(record) { return record.draft?.data || record.tool.data || {}; }
  function conflict(record) {
    record.conflict = true;
    record.conflictBar.hidden = false;
    setSaveStatus(record, 'Room changed · your draft is preserved', true);
    clearTimeout(record.debounce);
  }
  function create(kind, values = {}) {
    if (!TOOL_DEFAULTS[kind]) return;
    const defaults = TOOL_DEFAULTS[kind];
    const center = win.QuorumCanvas?.center?.() || { x: .5, y: .5 };
    const position = screenPlacement(center, kind, bridge.read().room || {});
    const payload = { type: 'workspace:create', kind, title: values.title || defaults.title, ...position };
    if (kind === 'embed') {
      try { payload.url = normalizeEmbedUrl(values.url, win.location?.origin); }
      catch (error) { announce(error.message, true); return; }
    }
    if (send(payload)) {
      awaitingCreate = { kind, ids: new Set(records.keys()), at: Date.now() };
      announce('Screen added to the shared canvas.');
      dialog?.close?.();
    }
  }
  function createScreen(tool, index) {
    const record = { tool, draft: null, conflict: false, moving: false, render() {} };
    const node = record.node = element('section', `q-tool-screen q-tool-kind-${tool.kind}`);
    node.dataset.toolId = tool.id;
    node.setAttribute('aria-label', `${tool.title} shared screen`);
    const bringToFront = () => { node.style.zIndex = String(++frontOrder); };
    node.addEventListener('pointerdown', bringToFront, true);
    node.addEventListener('focusin', bringToFront);
    bringToFront();
    // Typing and keyboard actions in a screen belong to the editor, not the room camera.
    node.addEventListener('keydown', event => { if (event.key !== 'Escape') event.stopPropagation(); });
    const header = record.header = element('header', 'q-tool-screen-head');
    header.tabIndex = 0;
    header.setAttribute('aria-label', 'Move screen with arrow keys; hold Shift for larger steps');
    const channel = record.channel = element('span', 'q-tool-channel', `CH ${String(index + 1).padStart(2, '0')}`);
    const light = element('span', 'q-tool-live'); light.setAttribute('aria-hidden', 'true');
    const title = record.title = element('input', 'q-tool-screen-title');
    title.type = 'text'; title.value = tool.title; title.maxLength = 80;
    title.setAttribute('aria-label', 'Screen title');
    title.addEventListener('change', () => { const value = title.value.trim(); if (value && value !== record.tool.title) send({ type: 'workspace:update', id: tool.id, title: value }); else title.value = record.tool.title; });
    header.append(light, channel, title,
      ...(tool.kind === 'embed' ? [] : [button('↓', 'Download this screen’s work', () => {
        const file = exportToolDocument(record.tool, dataOf(record));
        const url = win.URL.createObjectURL(new win.Blob([file.content], { type: file.mime }));
        const link = element('a'); link.href = url; link.download = file.filename; link.hidden = true;
        doc.body.append(link); link.click(); link.remove();
        setTimeout(() => win.URL.revokeObjectURL(url), 1000);
      })]),
      button('⛶', 'Expand screen', async () => {
        try { if (doc.fullscreenElement === node) await doc.exitFullscreen(); else if (node.requestFullscreen) await node.requestFullscreen(); else setSaveStatus(record, 'Fullscreen is unavailable in this browser.', true); }
        catch { setSaveStatus(record, 'Use the canvas zoom controls to enlarge this screen.', true); }
      }),
      button('×', 'Remove shared screen', () => { if (record.orphan) { removeRecord(tool.id, record); } else if (record.deleteArmed) send({ type: 'workspace:delete', id: tool.id }); else { record.deleteArmed = true; setSaveStatus(record, 'Press × again to remove for everyone.'); clearTimeout(record.deleteTimer); record.deleteTimer = setTimeout(() => { record.deleteArmed = false; if (!record.draft) setSaveStatus(record, 'Synced in this room'); }, 3500); } }));
    const content = record.content = element('div', 'q-tool-content');
    const conflictBar = record.conflictBar = element('div', 'q-tool-conflict');
    conflictBar.hidden = true;
    conflictBar.append(element('span', '', 'Someone updated this screen. Your draft is still here.'),
      button('Use room version', 'Discard my draft and use the room version', () => { record.draft = null; record.conflict = false; record.saveBlocked = false; conflictBar.hidden = true; record.render(); setSaveStatus(record, 'Synced in this room'); }),
      button('Apply my version', 'Replace the current room content with my visible draft', () => { if (!record.draft || record.orphan) return; record.conflict = false; record.saveBlocked = false; conflictBar.hidden = true; record.draft.baseData = clone(record.tool.data); record.draft.baseVersion = record.tool.version; record.draft.pendingData = null; flush(record); }));
    const footer = element('footer', 'q-tool-screen-foot');
    record.save = element('span', 'q-tool-save', 'Synced in this room');
    const kindLabel = element('span', 'q-tool-kind', tool.kind === 'embed' ? 'WEB CHANNEL' : tool.kind.toUpperCase());
    const resizer = button('◢', 'Resize screen with arrow keys or drag', () => {}, 'q-tool-resizer');
    footer.append(kindLabel, record.save, resizer);
    node.append(header, conflictBar, content, footer);
    bindGeometry(record, header, false);
    bindGeometry(record, resizer, true);
    if (tool.kind === 'notes') buildNotes(record);
    else if (tool.kind === 'tasks') buildTasks(record);
    else if (tool.kind === 'board') buildBoard(record);
    else if (tool.kind === 'timer') buildTimer(record);
    else buildEmbed(record);
    container.append(node);
    place(record);
    return record;
  }
  function bindGeometry(record, handle, resize) {
    let drag = null;
    const toWorld = event => win.QuorumCanvas?.screenToWorld?.(event.clientX, event.clientY) || { x: event.clientX / WORLD.width, y: event.clientY / WORLD.height };
    const finish = event => {
      if (!drag || (event.pointerId !== undefined && event.pointerId !== drag.id)) return;
      const changed = drag.changed;
      const geometry = record.geometry;
      const pointerId = drag.id;
      drag = null;
      record.moving = false;
      record.node.classList.remove('is-moving');
      if (changed) {
        record.tool = { ...record.tool, ...geometry };
        send({ type: 'workspace:update', id: record.tool.id, ...geometry });
      }
      record.geometry = null;
      place(record);
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
    };
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || record.orphan || doc.fullscreenElement === record.node || (!resize && event.target.closest('button,input,a,textarea'))) return;
      event.preventDefault(); event.stopPropagation();
      drag = { id: event.pointerId, start: toWorld(event), geometry: { x: record.tool.x, y: record.tool.y, w: record.tool.w, h: record.tool.h }, changed: false };
      record.geometry = { ...drag.geometry };
      record.moving = true;
      record.node.classList.add('is-moving');
      handle.setPointerCapture?.(event.pointerId);
    });
    handle.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const point = toWorld(event);
      const dx = point.x - drag.start.x, dy = point.y - drag.start.y;
      record.geometry = resize ? { ...drag.geometry, w: clamp(drag.geometry.w + dx, .18, 1.5), h: clamp(drag.geometry.h + dy, .15, 1.5) } : { ...drag.geometry, x: clamp(drag.geometry.x + dx, -100, 100), y: clamp(drag.geometry.y + dy, -100, 100) };
      drag.changed ||= Math.abs(dx) + Math.abs(dy) > .002;
      place(record, record.geometry);
      event.preventDefault(); event.stopPropagation();
    });
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', finish);
    handle.addEventListener('keydown', event => {
      if (event.target !== handle || doc.fullscreenElement === record.node || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const step = event.shiftKey ? 40 : 10;
      const dx = event.key === 'ArrowRight' ? step / WORLD.width : event.key === 'ArrowLeft' ? -step / WORLD.width : 0;
      const dy = event.key === 'ArrowDown' ? step / WORLD.height : event.key === 'ArrowUp' ? -step / WORLD.height : 0;
      const geometry = resize ? { w: clamp(record.tool.w + dx, .18, 1.5), h: clamp(record.tool.h + dy, .15, 1.5) } : { x: clamp(record.tool.x + dx, -100, 100), y: clamp(record.tool.y + dy, -100, 100) };
      place(record, { ...record.tool, ...geometry });
      record.tool = { ...record.tool, ...geometry };
      send({ type: 'workspace:update', id: record.tool.id, ...geometry });
    });
  }
  function buildNotes(record) {
    const input = element('textarea', 'q-tool-notes');
    input.placeholder = 'A thought, a decision, the next big idea…'; input.maxLength = 20000;
    input.setAttribute('aria-label', 'Shared notes');
    input.addEventListener('input', () => queueData(record, { text: input.value }));
    input.addEventListener('blur', () => { flush(record); if (!record.draft) record.render(); });
    record.content.append(input);
    record.render = () => {
      if (record.draft) return;
      const text = record.tool.data?.text || '';
      if (input.value === text) return;
      const focused = doc.activeElement === input;
      const start = input.selectionStart, end = input.selectionEnd;
      input.value = text;
      if (focused) input.setSelectionRange(Math.min(start, text.length), Math.min(end, text.length));
    };
  }
  function buildTasks(record) {
    const list = element('div', 'q-tool-task-list');
    const form = element('form', 'q-tool-task-form');
    const input = element('input', 'q-tool-task-input');
    input.type = 'text'; input.maxLength = 300; input.placeholder = 'Add the next step…'; input.setAttribute('aria-label', 'New checklist item');
    const add = element('button', 'q-tool-button', '+ Add'); add.type = 'submit';
    form.append(input, add);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const text = input.value.trim(), items = dataOf(record).items || [];
      if (!text) return;
      if (items.length >= 100) { setSaveStatus(record, 'This checklist holds up to 100 items.', true); return; }
      queueData(record, { items: [...items, { id: uid(), text, done: false }] });
      input.value = ''; record.render();
    });
    record.content.append(list, form);
    record.render = () => {
      list.replaceChildren();
      const items = dataOf(record).items || [];
      if (!items.length) list.append(element('p', 'q-tool-empty', 'Clear a path. Add something to do together.'));
      items.forEach(item => {
        const row = element('div', `q-tool-task-row${item.done ? ' is-done' : ''}`);
        const label = element('label', 'q-tool-task-label');
        const check = element('input'); check.type = 'checkbox'; check.checked = item.done;
        check.addEventListener('change', () => { queueData(record, { items: (dataOf(record).items || []).map(other => other.id === item.id ? { ...other, done: check.checked } : other) }); record.render(); });
        label.append(check, element('span', '', item.text));
        row.append(label, button('×', `Remove task: ${item.text}`, () => { queueData(record, { items: (dataOf(record).items || []).filter(other => other.id !== item.id) }); record.render(); }));
        list.append(row);
      });
    };
  }
  function buildTimer(record) {
    const clock = element('output', 'q-tool-clock', '25:00'); clock.setAttribute('aria-label', 'Time remaining');
    const caption = element('span', 'q-tool-timer-caption', 'A shared moment of focus');
    const actions = element('div', 'q-tool-timer-actions');
    const minutes = element('input', 'q-tool-minutes');
    minutes.type = 'number'; minutes.min = '1'; minutes.max = '1440'; minutes.value = '25'; minutes.setAttribute('aria-label', 'Timer duration in minutes');
    const toggle = button('Start', 'Start or pause the shared timer', () => {
      const data = dataOf(record);
      if (data.running && timerRemaining(data) > 0) queueData(record, { durationMs: timerRemaining(data), startedAt: null, running: false });
      else {
        const durationMs = timerRemaining(data) || clamp(Number(minutes.value) || 25, 1, 1440) * 60000;
        queueData(record, { durationMs, startedAt: Date.now(), running: true });
      }
      record.render(); flush(record);
    });
    const reset = button('Set time', 'Set the shared timer to the chosen minutes', () => { queueData(record, { durationMs: clamp(Number(minutes.value) || 25, 1, 1440) * 60000, startedAt: null, running: false }); record.render(); flush(record); });
    actions.append(minutes, element('span', 'q-tool-min-label', 'min'), toggle, reset);
    record.content.append(clock, caption, actions);
    record.render = () => {
      const data = dataOf(record), remaining = timerRemaining(data);
      clock.textContent = formatTimer(remaining);
      record.node.classList.toggle('is-timer-running', !!data.running && remaining > 0);
      caption.textContent = data.running && !remaining ? 'Time is up · take a breath together' : data.running ? 'Running together across the room' : 'Set a time, then start together';
      toggle.textContent = data.running && remaining > 0 ? 'Pause' : 'Start';
    };
  }
  function buildBoard(record) {
    const tools = element('div', 'q-tool-board-tools');
    let color = '#66dfbd', width = 4, current = null;
    ['#66dfbd', '#f3f5f8', '#91b8ff', '#f4c982', '#ee95be'].forEach(value => {
      const swatch = button('', `Draw in ${value}`, () => { color = value; tools.querySelectorAll('.q-tool-swatch').forEach(node => node.setAttribute('aria-pressed', String(node === swatch))); }, 'q-tool-swatch');
      swatch.style.setProperty('--swatch', value); swatch.setAttribute('aria-pressed', String(value === color)); tools.append(swatch);
    });
    tools.append(button('Undo', 'Remove the latest shared stroke', () => { queueData(record, { strokes: (dataOf(record).strokes || []).slice(0, -1) }); record.render(); }));
    const thickness = element('select', 'q-tool-thickness'); thickness.setAttribute('aria-label', 'Stroke width');
    [2, 4, 8].forEach(value => { const option = element('option', '', `${value}px`); option.value = String(value); option.selected = value === 4; thickness.append(option); });
    thickness.addEventListener('change', () => { width = Number(thickness.value); }); tools.append(thickness);
    const canvas = element('canvas', 'q-tool-board'); canvas.width = 1000; canvas.height = 600;
    canvas.setAttribute('aria-label', 'Shared drawing board. Draw with a mouse, touch, or pen.'); canvas.tabIndex = 0;
    const context = canvas.getContext('2d');
    function paint(stroke) {
      if (!context || !stroke.points?.length) return;
      context.strokeStyle = stroke.color; context.fillStyle = stroke.color; context.lineWidth = stroke.width; context.lineCap = 'round'; context.lineJoin = 'round';
      context.beginPath();
      stroke.points.forEach((point, index) => { if (index) context.lineTo(point.x * 1000, point.y * 600); else context.moveTo(point.x * 1000, point.y * 600); });
      if (stroke.points.length === 1) { const point = stroke.points[0]; context.arc(point.x * 1000, point.y * 600, stroke.width / 2, 0, Math.PI * 2); context.fill(); }
      else context.stroke();
    }
    function point(event) { const rect = canvas.getBoundingClientRect(); return { x: Math.round(clamp((event.clientX - rect.left) / rect.width, 0, 1) * 10000) / 10000, y: Math.round(clamp((event.clientY - rect.top) / rect.height, 0, 1) * 10000) / 10000 }; }
    record.render = () => { context?.clearRect(0, 0, 1000, 600); (dataOf(record).strokes || []).forEach(paint); if (current) paint(current); };
    canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0 || record.orphan) return;
      const strokes = dataOf(record).strokes || [], total = strokes.reduce((count, stroke) => count + stroke.points.length, 0);
      if (strokes.length >= 200 || total >= 4000) { setSaveStatus(record, 'Board is full. Undo a stroke or add another board.', true); return; }
      current = { id: uid(), color, width, points: [point(event)] }; record.boardPointer = event.pointerId;
      record.boardPointBudget = 4000 - total; canvas.setPointerCapture?.(event.pointerId); event.preventDefault(); event.stopPropagation(); record.render();
    });
    canvas.addEventListener('pointermove', event => {
      if (!current || event.pointerId !== record.boardPointer || current.points.length >= record.boardPointBudget) return;
      const next = point(event), last = current.points.at(-1);
      if (Math.hypot(next.x - last.x, next.y - last.y) < .002) return;
      current.points.push(next); record.render(); event.preventDefault(); event.stopPropagation();
    });
    const finish = event => {
      if (!current || event.pointerId !== record.boardPointer) return;
      const stroke = current; current = null;
      queueData(record, { strokes: [...(dataOf(record).strokes || []), stroke] });
      record.render(); event.stopPropagation();
    };
    canvas.addEventListener('pointerup', finish); canvas.addEventListener('pointercancel', finish);
    record.content.append(tools, canvas);
  }
  function buildEmbed(record) {
    let src;
    try { src = normalizeEmbedUrl(record.tool.url, win.location?.origin); }
    catch (error) { record.content.append(element('p', 'q-tool-empty', error.message)); return; }
    const frame = element('iframe', 'q-tool-frame');
    frame.title = record.tool.title;
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin allow-popups allow-presentation');
    frame.setAttribute('allow', 'fullscreen; clipboard-write');
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    frame.setAttribute('allowfullscreen', '');
    const note = element('div', 'q-tool-frame-note');
    const message = element('span', '', 'Loading embedded page…');
    const retry = button('Reload', 'Reload this embedded page', () => { frame.src = src; waitForFrame(); });
    const form = element('form', 'q-tool-url-form'); form.hidden = true;
    const urlInput = element('input'); urlInput.type = 'url'; urlInput.required = true; urlInput.maxLength = 2048;
    urlInput.setAttribute('aria-label', 'Replacement embed URL'); urlInput.value = src;
    const tune = element('button', 'q-tool-button', 'Tune in'); tune.type = 'submit';
    form.append(urlInput, tune, button('Cancel', 'Cancel changing the embed URL', () => { form.hidden = true; }));
    form.addEventListener('submit', event => {
      event.preventDefault();
      try {
        const url = normalizeEmbedUrl(urlInput.value, win.location?.origin);
        if (send({ type: 'workspace:update', id: record.tool.id, url, baseVersion: record.tool.version })) record.pendingUrl = url;
      } catch (error) { setSaveStatus(record, error.message, true); }
    });
    note.append(message, retry, button('Change URL', 'Change the tool on this shared screen', () => { form.hidden = !form.hidden; if (!form.hidden) { urlInput.value = record.tool.url; urlInput.focus(); } }));
    function waitForFrame() {
      clearTimeout(record.frameTimer); message.textContent = 'Loading embedded page…';
      record.frameTimer = setTimeout(() => { message.textContent = 'Still waiting? The provider may require sign-in or block embedding.'; }, 10000);
    }
    frame.addEventListener('load', () => { clearTimeout(record.frameTimer); message.textContent = 'If the frame is blank, this provider may block embedding. Try its official embed link.'; });
    frame.addEventListener('error', () => { clearTimeout(record.frameTimer); message.textContent = 'The embedded page could not load. Check the URL and the provider’s embedding permissions.'; });
    frame.src = src;
    record.content.append(frame, note, form); waitForFrame();
    record.render = () => {
      frame.title = record.tool.title;
      if (record.tool.url !== src) {
        try { src = normalizeEmbedUrl(record.tool.url, win.location?.origin); frame.src = src; waitForFrame(); }
        catch (error) { frame.removeAttribute('src'); message.textContent = error.message; }
      }
      if (record.pendingUrl === record.tool.url) { record.pendingUrl = null; form.hidden = true; }
    };
  }
  function updateRoom(room) {
    const incoming = new Set();
    (room?.tools || []).forEach((tool, index) => {
      incoming.add(tool.id);
      let record = records.get(tool.id);
      if (!record) { record = createScreen(tool, index); records.set(tool.id, record); }
      else {
        const reconciled = reconcileDraft(record.draft, tool);
        record.draft = reconciled.draft;
        if (reconciled.status === 'conflict') conflict(record);
        else if (reconciled.status === 'clean') { record.conflict = false; record.conflictBar.hidden = true; setSaveStatus(record, 'Synced in this room'); }
        record.tool = tool;
        if (reconciled.status === 'dirty') scheduleSave(record);
      }
      record.channel.textContent = `CH ${String(index + 1).padStart(2, '0')}`;
      if (doc.activeElement !== record.title) record.title.value = tool.title;
      record.node.setAttribute('aria-label', `${tool.title} shared screen`);
      place(record); record.render();
    });
    records.forEach((record, id) => {
      if (incoming.has(id)) return;
      if (record.draft) { record.orphan = true; record.title.disabled = true; clearTimeout(record.debounce); record.conflictBar.hidden = true; setSaveStatus(record, 'Removed from room · download your draft before closing', true); }
      else removeRecord(id, record);
    });
    const hasTimer = Array.from(records.values()).some(record => record.tool.kind === 'timer');
    if (!timer && hasTimer) timer = setInterval(() => records.forEach(record => { if (record.tool.kind === 'timer') record.render(); }), 250);
    if (timer && !hasTimer) { clearInterval(timer); timer = null; }
    if (awaitingCreate) {
      const mine = (room?.tools || []).some(tool => !awaitingCreate.ids.has(tool.id) && tool.kind === awaitingCreate.kind && tool.createdBy === bridge.read().selfId);
      if (mine) { awaitingCreate = null; win.QuorumCanvas?.fit?.(); }
      else if (Date.now() - awaitingCreate.at > 10000) awaitingCreate = null;
    }
  }
  function removeRecord(id, record) {
    clearTimeout(record.debounce); clearTimeout(record.frameTimer); clearTimeout(record.deleteTimer);
    record.node.remove(); records.delete(id);
  }
  function reset() {
    records.forEach((record, id) => removeRecord(id, record));
    if (timer) clearInterval(timer); timer = null;
    awaitingCreate = null;
    frontOrder = 0;
    announce('');
  }
  function handleConflict(tool) {
    const record = tool && records.get(tool.id);
    if (!record) return;
    record.tool = tool;
    if (record.draft) {
      if (equal(tool.data, record.draft.baseData)) {
        record.draft.baseVersion = tool.version;
        record.draft.pendingData = null;
        record.conflict = false; record.conflictBar.hidden = true;
        scheduleSave(record);
      } else conflict(record);
    }
    place(record); record.render();
  }
  function handleError(message) {
    if (!message?.code?.startsWith('WORKSPACE_')) return;
    announce(message.message || 'The screen could not be updated.', true);
    const record = records.get(message.id || message.tool?.id);
    if (message.code === 'WORKSPACE_CONFLICT') { handleConflict(message.tool); return; }
    if (record?.draft) { record.draft.pendingData = null; record.saveBlocked = true; setSaveStatus(record, message.message || 'Could not save · draft kept here', true); }
  }
  doc.querySelectorAll('[data-workspace-kind]').forEach(node => node.addEventListener('click', () => {
    if (node.dataset.workspaceKind === 'embed') { doc.getElementById('qToolEmbedForm')?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); doc.getElementById('qToolUrl')?.focus(); }
    else create(node.dataset.workspaceKind);
  }));
  doc.querySelectorAll('[data-workspace-preset]').forEach(node => node.addEventListener('click', () => create('embed', { url: node.dataset.workspacePreset, title: node.dataset.title || node.textContent.trim() })));
  doc.getElementById('qToolEmbedForm')?.addEventListener('submit', event => {
    event.preventDefault(); create('embed', { url: doc.getElementById('qToolUrl')?.value, title: doc.getElementById('qToolTitle')?.value.trim() });
  });
  updateRoom(bridge.read().room);
  return { updateRoom, reset, handleConflict, handleError, create };
}

if (typeof window !== 'undefined' && window.QuorumWorkspaceBridge) {
  window.QuorumWorkspaceUI = createWorkspaceUI(window.QuorumWorkspaceBridge);
}
