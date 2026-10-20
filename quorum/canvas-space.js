/* A local camera over a shared, unbounded room. Room positions stay in world fractions. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (!root?.document) return;
  const stage = root.document.getElementById('qStage');
  const world = root.document.getElementById('qWorld');
  if (stage && world) {
    root.QuorumCanvas = api.createCanvasController({ window: root, document: root.document, stage, world });
    root.QuorumCanvas.bind();
  }
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const WORLD_WIDTH = 1600;
  const WORLD_HEIGHT = 1000;
  const MIN_ZOOM = 0.12;
  const MAX_ZOOM = 2.5;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function screenToWorld(camera, x, y, rect = { left: 0, top: 0 }) {
    return { x: (x - rect.left - camera.x) / camera.scale / WORLD_WIDTH,
      y: (y - rect.top - camera.y) / camera.scale / WORLD_HEIGHT };
  }
  function worldToScreen(camera, x, y, rect = { left: 0, top: 0 }) {
    return { x: rect.left + camera.x + x * WORLD_WIDTH * camera.scale,
      y: rect.top + camera.y + y * WORLD_HEIGHT * camera.scale };
  }
  function zoomCamera(camera, factor, point) {
    const scale = clamp(camera.scale * factor, MIN_ZOOM, MAX_ZOOM);
    const ratio = scale / camera.scale;
    return { scale, x: point.x - (point.x - camera.x) * ratio,
      y: point.y - (point.y - camera.y) * ratio };
  }
  function fitCamera(bounds, width, height, padding = 64) {
    const scale = clamp(Math.min(Math.max(1, width - padding * 2) / Math.max(1, bounds.width),
      Math.max(1, height - padding * 2) / Math.max(1, bounds.height)), MIN_ZOOM, 1);
    return { scale, x: width / 2 - (bounds.x + bounds.width / 2) * scale,
      y: height / 2 - (bounds.y + bounds.height / 2) * scale };
  }
  function isEditing(target) {
    return !!target?.closest?.('input,textarea,select,[contenteditable="true"],[contenteditable=""]');
  }

  function createCanvasController({ window: win, document: doc, stage, world }) {
    let camera = { x: 0, y: 0, scale: 1 };
    let bound = false;
    let live = false;
    let firstView = true;
    let spaceDown = false;
    let panMode = false;
    let viewport = { width: 0, height: 0 };
    let pinch = null;
    const pointers = new Map();
    const listeners = [];
    const byId = (id) => doc.getElementById(id);
    const localPoint = (x, y) => { const rect = stage.getBoundingClientRect(); return { x: x - rect.left, y: y - rect.top }; };
    const on = (target, name, handler, options) => {
      target?.addEventListener(name, handler, options);
      listeners.push(() => target?.removeEventListener(name, handler, options));
    };
    function paint() {
      world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
      stage.style.setProperty('--canvas-grid-size', `${32 * camera.scale}px`);
      stage.style.setProperty('--canvas-grid-x', `${camera.x}px`);
      stage.style.setProperty('--canvas-grid-y', `${camera.y}px`);
      stage.classList.toggle('q-canvas-panning', pointers.size > 0);
      stage.classList.toggle('q-canvas-pan-mode', panMode || spaceDown);
      const label = byId('qCanvasZoomLabel');
      if (label) label.textContent = `${Math.round(camera.scale * 100)}%`;
      byId('qCanvasPanBtn')?.setAttribute('aria-pressed', String(panMode));
    }
    function resize() {
      const rect = stage.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      if (viewport.width && viewport.height) {
        camera.x += (rect.width - viewport.width) / 2;
        camera.y += (rect.height - viewport.height) / 2;
      } else {
        camera.x = rect.width / 2 - WORLD_WIDTH / 2;
        camera.y = rect.height / 2 - WORLD_HEIGHT / 2;
      }
      viewport = { width: rect.width, height: rect.height };
      paint();
    }
    function zoomBy(factor, clientX, clientY) {
      const rect = stage.getBoundingClientRect();
      const point = Number.isFinite(clientX) && Number.isFinite(clientY)
        ? localPoint(clientX, clientY) : { x: rect.width / 2, y: rect.height / 2 };
      camera = zoomCamera(camera, factor, point);
      paint();
    }
    function reset() {
      const rect = stage.getBoundingClientRect();
      camera = { scale: 1, x: rect.width / 2 - WORLD_WIDTH / 2, y: rect.height / 2 - WORLD_HEIGHT / 2 };
      paint();
    }
    function fit() {
      const rect = stage.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const nodes = [...world.querySelectorAll('.q-box,.q-group,.q-tool-screen')];
      const bounds = nodes.map((node) => node.getBoundingClientRect()).filter((box) => box.width && box.height);
      let worldBounds = { x: 0, y: 0, width: WORLD_WIDTH, height: WORLD_HEIGHT };
      if (bounds.length) {
        const left = Math.min(...bounds.map((box) => box.left));
        const top = Math.min(...bounds.map((box) => box.top));
        const right = Math.max(...bounds.map((box) => box.right ?? box.left + box.width));
        const bottom = Math.max(...bounds.map((box) => box.bottom ?? box.top + box.height));
        const start = screenToWorld(camera, left, top, rect);
        worldBounds = { x: start.x * WORLD_WIDTH, y: start.y * WORLD_HEIGHT,
          width: (right - left) / camera.scale, height: (bottom - top) / camera.scale };
      }
      camera = fitCamera(worldBounds, rect.width, rect.height, rect.width < 600 ? 32 : 64);
      paint();
    }
    function clearPointers() {
      pointers.clear();
      pinch = null;
      paint();
    }
    function pointerDown(event) {
      if (!live || (event.button !== 0 && event.button !== 1)) return;
      if (event.target?.closest?.('.q-tool-screen,.qd-studio,button,a,input,textarea,select,[contenteditable],.q-shared-stage')) return;
      if (!(panMode || spaceDown || event.button === 1) && event.target?.closest?.('.q-box,.q-group-head')) return;
      event.preventDefault();
      stage.setPointerCapture?.(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { camera: { ...camera }, distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
          middle: localPoint((a.x + b.x) / 2, (a.y + b.y) / 2) };
      }
      paint();
    }
    function pointerMove(event) {
      const previous = pointers.get(event.pointerId);
      if (!previous) return;
      event.preventDefault();
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size >= 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const middle = localPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        camera = zoomCamera(pinch.camera, distance / pinch.distance, pinch.middle);
        camera.x += middle.x - pinch.middle.x;
        camera.y += middle.y - pinch.middle.y;
      } else {
        camera.x += event.clientX - previous.x;
        camera.y += event.clientY - previous.y;
      }
      paint();
    }
    function pointerUp(event) {
      if (!pointers.delete(event.pointerId)) return;
      pinch = null;
      if (stage.hasPointerCapture?.(event.pointerId)) stage.releasePointerCapture(event.pointerId);
      paint();
    }
    function setLive(next) {
      live = !!next;
      if (!live) {
        clearPointers();
        spaceDown = false;
        panMode = false;
        firstView = true;
        return;
      }
      resize();
      if (firstView) { firstView = false; fit(); }
    }
    function bind() {
      if (bound) return;
      bound = true;
      on(stage, 'pointerdown', pointerDown);
      on(stage, 'pointermove', pointerMove);
      for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) on(stage, name, pointerUp);
      on(stage, 'wheel', (event) => {
        if (!live || event.target?.closest?.('.q-tool-screen,.qd-studio,.q-shared-stage')) return;
        event.preventDefault();
        const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1);
        zoomBy(Math.exp(-clamp(delta, -160, 160) * 0.003), event.clientX, event.clientY);
      }, { passive: false });
      on(byId('qCanvasZoomIn'), 'click', () => zoomBy(1.2));
      on(byId('qCanvasZoomOut'), 'click', () => zoomBy(1 / 1.2));
      on(byId('qCanvasFit'), 'click', fit);
      on(byId('qCanvasReset'), 'click', reset);
      on(byId('qCanvasPanBtn'), 'click', () => { panMode = !panMode; paint(); });
      on(win, 'keydown', (event) => {
        if (!live || isEditing(event.target) || event.target?.closest?.('.qd-studio,.q-thinking') || event.ctrlKey || event.metaKey || event.altKey || doc.querySelector?.('dialog[open]')) return;
        if (event.key === ' ') { spaceDown = true; event.preventDefault(); paint(); }
        else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1.2); }
        else if (event.key === '-') { event.preventDefault(); zoomBy(1 / 1.2); }
        else if (event.key === '0') { event.preventDefault(); reset(); }
        else if (event.key.toLowerCase() === 'f') { event.preventDefault(); fit(); }
        else if (event.target === stage && event.key.startsWith('Arrow')) {
          event.preventDefault();
          camera.x += event.key === 'ArrowRight' ? -80 : event.key === 'ArrowLeft' ? 80 : 0;
          camera.y += event.key === 'ArrowDown' ? -80 : event.key === 'ArrowUp' ? 80 : 0;
          paint();
        }
      });
      on(win, 'keyup', (event) => { if (event.key === ' ') { spaceDown = false; paint(); } });
      on(win, 'blur', () => { spaceDown = false; clearPointers(); });
      const observer = win.ResizeObserver ? new win.ResizeObserver(resize) : null;
      observer?.observe(stage);
      if (observer) listeners.push(() => observer.disconnect());
      else on(win, 'resize', resize);
      resize();
    }
    return { bind, setLive, resize, fit, reset, zoomBy,
      screenToWorld: (x, y) => screenToWorld(camera, x, y, stage.getBoundingClientRect()),
      worldToScreen: (x, y) => worldToScreen(camera, x, y, stage.getBoundingClientRect()),
      center: () => { const rect = stage.getBoundingClientRect(); return screenToWorld(camera, rect.left + rect.width / 2, rect.top + rect.height / 2, rect); },
      isPanning: () => spaceDown || panMode || pointers.size > 0,
      destroy: () => { live = false; clearPointers(); listeners.splice(0).forEach((off) => off()); bound = false; }
    };
  }
  return { WORLD_WIDTH, WORLD_HEIGHT, MIN_ZOOM, MAX_ZOOM, screenToWorld, worldToScreen, zoomCamera, fitCamera, createCanvasController };
});
