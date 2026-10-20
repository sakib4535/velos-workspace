'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'quorum', 'quorum-app.js'), 'utf8')
  .replace(/\ninitJoinScreen\(\);\s*bindControls\(\);\s*$/, '');
const flush = () => new Promise((resolve) => setImmediate(resolve));

class FakeStream {
  constructor(tracks = []) { this.tracks = [...tracks]; }
  getTracks() { return [...this.tracks]; }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
  addTrack(track) { this.tracks.push(track); }
  removeTrack(track) { this.tracks = this.tracks.filter((item) => item !== track); }
}

function track(kind) {
  return {
    kind, enabled: true, readyState: 'live', stops: 0,
    stop() { this.readyState = 'ended'; this.stops += 1; },
    end() { this.readyState = 'ended'; this.onended?.(); },
    getSettings() { return { facingMode: 'user' }; }
  };
}

function harness() {
  const requests = [];
  const syncs = [];
  const sent = [];
  const toasts = [];
  const elements = new Map();
  const context = vm.createContext({
    window: { QUORUM_CONFIG: {} },
    location: { hostname: 'localhost', host: 'localhost:8788', protocol: 'http:' },
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { play: async () => {} });
      return elements.get(id);
    } },
    navigator: { mediaDevices: { getUserMedia(constraints) {
      let resolve;
      let reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      requests.push({ constraints, resolve: (...tracks) => resolve(new FakeStream(tracks)), reject });
      return promise;
    } } },
    MediaStream: FakeStream, URL, URLSearchParams, setTimeout, clearTimeout, console,
    syncs, sent, toasts
  });
  vm.runInContext(source, context);
  vm.runInContext(`
    renderStage = syncDock = finishHostHandDrag = stopGestureEngine = () => {};
    startGestureEngine = async () => {};
    syncLocalTracksToPeer = async (peer) => syncs.push({ peer, tracks: S.localStream.getTracks() });
    send = (message) => sent.push(message);
    toast = (message) => toasts.push(message);
    S.joined = true;
    S.roomId = 'room';
    S.peers.set('remote', { id: 'remote' });
  `, context);
  return { ...vm.runInContext('({ S, E, acquireMedia, toggleMic, toggleCam })', context), requests, syncs, sent, toasts };
}

test('camera starts sending to existing peers without waiting for microphone permission', async () => {
  const h = harness();
  const ready = h.acquireMedia();
  assert.equal(h.requests.length, 2, 'Both device prompts start independently');
  assert.equal(h.requests[0].constraints.audio, false);
  assert.equal(h.requests[1].constraints.video, false);
  const video = track('video');
  h.requests[0].resolve(video);
  await flush();
  assert.equal(h.S.cameraTrack, video);
  assert.equal(h.S.micTrack, null);
  assert.equal(h.E.qCamVideo.srcObject, h.S.localStream);
  assert.equal(h.syncs[0].tracks[0], video);
  const audio = track('audio');
  h.requests[1].resolve(audio);
  const stream = await ready;
  assert.equal(stream, h.S.localStream);
  assert.equal(stream.getTracks().length, 2);
  assert.equal(h.syncs.length, 2);
});

test('microphone starts sending while camera permission is still pending', async () => {
  const h = harness();
  const ready = h.acquireMedia();
  const audio = track('audio');
  h.requests[1].resolve(audio);
  await flush();
  assert.equal(h.S.micTrack, audio);
  assert.equal(h.S.cameraTrack, null);
  assert.equal(h.syncs[0].tracks[0], audio);
  h.requests[0].reject({ name: 'NotAllowedError' });
  await ready;
  assert.equal(h.S.micOn, true);
  assert.equal(h.S.camOn, false);
  assert.match(h.toasts[0], /Camera permission blocked/);
});

for (const [kind, index, toggle, state] of [
  ['video', 0, 'toggleCam', 'cameraTrack'], ['audio', 1, 'toggleMic', 'micTrack']
]) {
  test(`a denied ${kind} device can be acquired after permission changes using its control`, async () => {
    const h = harness();
    const ready = h.acquireMedia();
    h.requests[index].reject({ name: 'NotAllowedError' });
    h.requests[1 - index].resolve(track(kind === 'video' ? 'audio' : 'video'));
    await ready;
    assert.equal(h.S[state], null);
    const retry = h[toggle]();
    assert.equal(h.requests.length, 3);
    const recovered = track(kind);
    h.requests[2].resolve(recovered);
    await retry;
    assert.equal(h.S[state], recovered);
    assert.equal(recovered.enabled, true);
    assert.ok(h.syncs.some((call) => call.tracks.includes(recovered)));
  });

  test(`toggling ${kind} off during a pending prompt preserves the choice without duplicate capture`, async () => {
    const h = harness();
    const ready = h.acquireMedia();
    const toggleReady = h[toggle]();
    assert.equal(h.requests.length, 2);
    const captured = track(kind);
    h.requests[index].resolve(captured);
    h.requests[1 - index].resolve(track(kind === 'video' ? 'audio' : 'video'));
    await Promise.all([ready, toggleReady]);
    assert.equal(captured.enabled, false);
    assert.equal(h.S[kind === 'video' ? 'camOn' : 'micOn'], false);
  });
}

test('late capture results after leaving are stopped and cannot overwrite a new room', async () => {
  const h = harness();
  const first = h.acquireMedia();
  h.S.mediaEpoch += 1;
  h.S.localStream = null;
  h.S.roomId = 'new-room';
  const second = h.acquireMedia();
  assert.equal(h.requests.length, 4, 'New room does not inherit pending permission requests');
  const lateVideo = track('video');
  h.requests[0].resolve(lateVideo);
  h.requests[1].reject({ name: 'NotAllowedError' });
  await first;
  assert.equal(lateVideo.readyState, 'ended');
  assert.equal(h.S.cameraTrack, null);
  assert.equal(h.S.camOn, true);
  assert.equal(h.toasts.length, 0);
  const currentVideo = track('video');
  const currentAudio = track('audio');
  h.requests[2].resolve(currentVideo);
  h.requests[3].resolve(currentAudio);
  await second;
  assert.equal(h.S.cameraTrack, currentVideo);
  assert.equal(h.S.micTrack, currentAudio);
});

test('an unplugged microphone updates presence and can be reacquired', async () => {
  const h = harness();
  const ready = h.acquireMedia();
  const audio = track('audio');
  h.requests[0].resolve(track('video'));
  h.requests[1].resolve(audio);
  await ready;
  audio.end();
  assert.equal(h.S.micTrack, null);
  assert.equal(h.S.micOn, false);
  assert.equal(h.sent.at(-1).micOn, false);
  const retry = h.toggleMic();
  const replacement = track('audio');
  h.requests[2].resolve(replacement);
  await retry;
  assert.equal(h.S.micTrack, replacement);
  assert.equal(h.S.localStream.getAudioTracks().length, 1);
});
