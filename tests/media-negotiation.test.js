'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const clientSource = fs.readFileSync(path.join(__dirname, '..', 'quorum', 'quorum-app.js'), 'utf8');

class MediaStreamModel {
  constructor(tracks = []) { this.tracks = [...tracks]; }
  getTracks() { return [...this.tracks]; }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
  addTrack(track) { if (!this.tracks.includes(track)) this.tracks.push(track); }
  removeTrack(track) { this.tracks = this.tracks.filter((item) => item !== track); }
}

function readMediaSections(sdp) {
  return sdp.split(/(?=m=)/).filter((section) => section.startsWith('m=')).map((section) => ({
    kind: /^m=(\w+)/.exec(section)[1],
    mid: /a=mid:([^\r\n]+)/.exec(section)[1],
    direction: /a=(sendrecv|sendonly|recvonly|inactive)/.exec(section)?.[1] || 'sendrecv'
  }));
}

function makeDescription(type = 'offer') {
  return {
    type,
    sdp: 'v=0\r\n' + ['audio', 'video'].map((kind, index) =>
      `m=${kind} 9 UDP/TLS/RTP/SAVPF ${kind === 'audio' ? 111 : 96}\r\na=mid:${index}\r\na=sendrecv\r\n`
    ).join('')
  };
}

// This model deliberately preserves the browser distinction between a
// reserved addTransceiver() sender and an addTrack() sender. An incoming
// offer can reuse only the latter; otherwise it creates a new transceiver.
// A generic signaling-state stub would miss the one-way-media regression.
class PeerConnectionModel {
  constructor(config) {
    this.config = config;
    this.connectionState = 'new';
    this.signalingState = 'stable';
    this.remoteDescription = null;
    this.localDescription = null;
    this.transceivers = [];
    this.answerSenders = [];
  }
  createTransceiver(kind, options, origin, track = null) {
    const sender = {
      track, streams: options.streams || [],
      async replaceTrack(nextTrack) { this.track = nextTrack; },
      setStreams(...streams) { this.streams = streams; }
    };
    const transceiver = {
      origin, mid: null, stopped: false,
      direction: options.direction || 'sendrecv', currentDirection: null,
      sender, receiver: { track: { id: `remote-${kind}`, kind, readyState: 'live' } }
    };
    this.transceivers.push(transceiver);
    return transceiver;
  }
  addTransceiver(kindOrTrack, options = {}) {
    const track = typeof kindOrTrack === 'string' ? null : kindOrTrack;
    return this.createTransceiver(track?.kind || kindOrTrack, options, 'addTransceiver', track);
  }
  addTrack(track, ...streams) {
    const reusable = this.transceivers.find((item) => !item.stopped && !item.sender.track &&
      item.receiver.track.kind === track.kind && !['sendrecv', 'sendonly'].includes(item.currentDirection));
    if (reusable) {
      reusable.sender.track = track;
      reusable.sender.streams = streams;
      reusable.direction = reusable.direction === 'inactive' ? 'sendonly' : 'sendrecv';
      reusable.origin = 'addTrack';
      return reusable.sender;
    }
    return this.createTransceiver(track.kind, { streams }, 'addTrack', track).sender;
  }
  getTransceivers() { return [...this.transceivers]; }
  getSenders() { return this.transceivers.map((item) => item.sender); }
  async setRemoteDescription(description) {
    if (description.type === 'offer') {
      for (const section of readMediaSections(description.sdp)) {
        let transceiver = this.transceivers.find((item) => item.mid === section.mid);
        if (!transceiver) {
          transceiver = this.transceivers.find((item) => item.mid === null &&
            item.origin === 'addTrack' && item.receiver.track.kind === section.kind);
        }
        if (!transceiver) transceiver = this.createTransceiver(section.kind, { direction: 'recvonly' }, 'remote');
        transceiver.mid = section.mid;
      }
      this.signalingState = 'have-remote-offer';
    } else {
      for (const section of readMediaSections(description.sdp)) {
        const transceiver = this.transceivers.find((item) => item.mid === section.mid);
        if (transceiver) transceiver.currentDirection = section.direction;
      }
      this.signalingState = 'stable';
    }
    this.remoteDescription = description;
  }
  async setLocalDescription() {
    const isAnswer = this.signalingState === 'have-remote-offer';
    const included = isAnswer ? this.transceivers.filter((item) => item.mid !== null) : this.transceivers;
    if (!isAnswer) {
      for (const [index, transceiver] of included.entries()) {
        if (transceiver.mid === null) transceiver.mid = String(index);
      }
    }
    this.localDescription = {
      type: isAnswer ? 'answer' : 'offer',
      sdp: 'v=0\r\n' + included.map((item) =>
        `m=${item.receiver.track.kind} 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:${item.mid}\r\na=${item.direction}\r\n`
      ).join('')
    };
    if (isAnswer) {
      this.answerSenders = included.map((item) => ({
        kind: item.receiver.track.kind, track: item.sender.track,
        streams: [...item.sender.streams], direction: item.direction
      }));
      for (const item of included) item.currentDirection = item.direction;
    }
    this.signalingState = isAnswer ? 'stable' : 'have-local-offer';
  }
  async addIceCandidate() {}
  close() { this.connectionState = 'closed'; }
  restartIce() {}
  getConfiguration() { return { ...this.config }; }
  setConfiguration(config) { this.config = config; }
}

function createMediaClient(selfId, peerId, withMedia = false) {
  const elements = new Map();
  const errors = [];
  let timerId = 0;
  const makeElement = () => ({
    dataset: {}, style: {}, hidden: false,
    classList: { add() {}, remove() {}, toggle() {} },
    querySelectorAll: () => [], querySelector: () => null,
    appendChild() {}, remove() {}, addEventListener() {}, setAttribute() {},
    play: async () => {}
  });
  const context = vm.createContext({
    window: { QUORUM_CONFIG: {} }, location: new URL('https://quorum.example/quorum/'),
    document: {
      hidden: false, body: makeElement(), createElement: makeElement,
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
      }
    },
    navigator: { onLine: true }, URL, URLSearchParams,
    console: { error: (...args) => errors.push(args), warn() {}, log() {} },
    setTimeout: () => ++timerId, clearTimeout() {}, setInterval: () => ++timerId, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    performance: { now: () => 0 },
    MediaStream: MediaStreamModel, RTCPeerConnection: PeerConnectionModel,
    WebSocket: { OPEN: 1 },
    RTCSessionDescription: class { constructor(value) { Object.assign(this, value); } },
    RTCIceCandidate: class { constructor(value) { Object.assign(this, value); } }
  });
  const withoutBoot = clientSource.replace(/\ninitJoinScreen\(\);\s*bindControls\(\);\s*$/, '\n');
  assert.notEqual(withoutBoot, clientSource, 'The harness must exclude only the UI boot calls');
  vm.runInContext(withoutBoot + `
    renderStage = () => {};
    syncDock = () => {};
    toast = () => {};
    globalThis.mediaClient = {
      S, ensurePeer, handleSignal,
      sync: (peer) => syncLocalTracksToPeer(peer)
    };
  `, context, { filename: 'quorum-app.js' });
  const client = { ...context.mediaClient, errors };
  client.S.selfId = selfId;
  client.S.joined = true;
  client.S.roomId = 'test-media';
  client.S.room = { id: 'test-media', participants: [{ id: selfId }, { id: peerId }] };
  client.sent = [];
  client.S.socket = { readyState: 1, send: (data) => client.sent.push(JSON.parse(data)) };
  if (withMedia) attachLocalMedia(client);
  return client;
}

function attachLocalMedia(client) {
  const audio = { id: 'microphone', kind: 'audio', enabled: true, readyState: 'live' };
  const video = { id: 'camera', kind: 'video', enabled: true, readyState: 'live' };
  // Real capture currently assembles camera before microphone. SDP ordering
  // must stay the same even when negotiation happens before capture finishes.
  client.S.localStream = new MediaStreamModel([video, audio]);
  client.S.cameraTrack = video;
  client.S.micTrack = audio;
  return { audio, video };
}

async function flushTasks() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

test('answerer adopts offered audio/video sections and attaches both local tracks before answering', async () => {
  const client = createMediaClient('peer-z', 'peer-a', true);
  const peer = client.ensurePeer('peer-a');
  assert.equal(peer.pc.getTransceivers().length, 0, 'An answerer must not reserve unassociated transceivers');
  await client.handleSignal('peer-a', { description: makeDescription() });
  assert.equal(peer.pc.getTransceivers().length, 2, 'An offer must create exactly its two media transceivers');
  assert.equal(peer.pc.localDescription.type, 'answer');
  assert.deepEqual(peer.pc.answerSenders.map((sender) => sender.kind), ['audio', 'video']);
  assert.deepEqual(peer.pc.answerSenders.map((sender) => sender.track), [client.S.micTrack, client.S.cameraTrack]);
  assert.ok(peer.pc.answerSenders.every((sender) => sender.direction === 'sendrecv'));
  assert.ok(peer.pc.answerSenders.every((sender) => sender.streams.includes(client.S.localStream)));
  assert.deepEqual(client.errors, []);
});

test('initial offer audio/video order is independent of whether device capture has finished', async () => {
  const mediaSections = [];
  for (const withMedia of [false, true]) {
    const client = createMediaClient('peer-a', 'peer-z', withMedia);
    const peer = client.ensurePeer('peer-z');
    await flushTasks();
    await peer.pc.onnegotiationneeded();
    assert.equal(peer.pc.localDescription?.type, 'offer');
    mediaSections.push(readMediaSections(peer.pc.localDescription.sdp).map((section) => section.kind));
    if (withMedia) {
      assert.equal(peer.pc.getTransceivers()[0].sender.track, client.S.micTrack);
      assert.equal(peer.pc.getTransceivers()[1].sender.track, client.S.cameraTrack);
    }
    assert.deepEqual(client.errors, []);
  }
  assert.deepEqual(mediaSections, [['audio', 'video'], ['audio', 'video']]);
});

test('capture arriving after the answer reuses negotiated senders for two-way audio/video', async () => {
  const client = createMediaClient('peer-z', 'peer-a');
  const peer = client.ensurePeer('peer-a');
  await client.handleSignal('peer-a', { description: makeDescription() });
  const original = peer.pc.getTransceivers();
  assert.equal(original.length, 2);
  assert.ok(original.every((item) => item.currentDirection === 'sendrecv'), 'Later capture needs negotiated sending rights');
  const { audio, video } = attachLocalMedia(client);
  await client.sync(peer);
  assert.deepEqual(peer.pc.getTransceivers(), original, 'Delayed tracks must not add new unnegotiated senders');
  assert.equal(original[0].sender.track, audio);
  assert.equal(original[1].sender.track, video);
  assert.ok(original.every((item) => item.sender.streams.includes(client.S.localStream)));
  assert.deepEqual(client.errors, []);
});

test('only the deterministic initial offerer initiates negotiation before any description exists', async () => {
  const client = createMediaClient('peer-z', 'peer-a', true);
  const peer = client.ensurePeer('peer-a');
  await flushTasks();
  await peer.pc.onnegotiationneeded();
  assert.equal(peer.pc.localDescription, null);
  assert.equal(client.sent.length, 0);
  assert.deepEqual(client.errors, []);
});
