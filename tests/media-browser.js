'use strict';

// Manual browser integration suite. Run `npm start`, open
// http://localhost:8788/tests/media-browser.html, and click Run tests.
// The actual app, signaling, RTCPeerConnection, and media rendering are used.
// Device acquisition alone is substituted, so this needs no device permissions.
(() => {
  const button = document.getElementById('run');
  const status = document.getElementById('status');
  const results = document.getElementById('results');
  const clients = document.getElementById('clients');
  const sources = document.getElementById('sources');
  const diagnostics = document.getElementById('diagnostics');
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  let inputs = [];
  let audioContext;
  let frames = [];
  const preparedMarkup = [];
  let htmlPromise;

  async function until(predicate, label, timeout = 18000) {
    const end = performance.now() + timeout;
    while (performance.now() < end) {
      if (await predicate()) return;
      await delay(150);
    }
    throw new Error(`Timed out: ${label}`);
  }

  function inputSource(index, config) {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    canvas.setAttribute('aria-label', `Synthetic participant ${index + 1}`);
    sources.append(canvas);
    const ctx = canvas.getContext('2d');
    let tick = 0;
    const paint = () => {
      tick += 1;
      ctx.fillStyle = index ? '#163354' : '#265139';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = index ? '#70b2ff' : '#83edb3';
      ctx.fillRect((tick * 4) % 280, 100, 40, 40);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 24px sans-serif';
      ctx.fillText(`Participant ${index + 1}`, 20, 40);
      ctx.font = '20px monospace';
      ctx.fillText(`Frame ${tick}`, 20, 76);
    };
    paint();
    const timer = setInterval(paint, 80);
    const video = canvas.captureStream(12);
    const oscillator = audioContext.createOscillator();
    oscillator.frequency.value = index ? 660 : 440;
    const gain = audioContext.createGain();
    gain.gain.value = 0.025;
    const audio = audioContext.createMediaStreamDestination();
    oscillator.connect(gain).connect(audio);
    oscillator.start();
    let release;
    const permission = new Promise((resolve) => { release = resolve; });
    if (!config.pending && !config.pendingCamera) release();
    return {
      calls: [], release,
      async getUserMedia(constraints) {
        this.calls.push(constraints.video ? 'video' : 'audio');
        if (config.pending || (constraints.video && config.pendingCamera)) await permission;
        if (constraints.video && config.denyCamera) {
          throw new DOMException('Camera denied for regression scenario', 'NotAllowedError');
        }
        const tracks = [];
        if (constraints.video) tracks.push(video.getVideoTracks()[0].clone());
        if (constraints.audio) tracks.push(audio.stream.getAudioTracks()[0].clone());
        return new MediaStream(tracks);
      },
      close() {
        release();
        clearInterval(timer);
        oscillator.stop();
        video.getTracks().forEach((track) => track.stop());
        audio.stream.getTracks().forEach((track) => track.stop());
        canvas.remove();
      }
    };
  }

  // The injected bridge is test-only. It never changes RTC negotiation logic.
  function bridge(index, wsUrl) {
    const storage = new Map();
    Object.defineProperty(window, 'sessionStorage', {
      value: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) }
    });
    window.QUORUM_CONFIG = { wsUrl, rtcConfig: { iceServers: [] } };
    const iceDiagnostics = window.quorumIceDiagnostics = { sent: 0, received: 0, applied: 0, errors: [] };
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', event => {
          try { if (JSON.parse(event.data).signal?.candidate) iceDiagnostics.received += 1; } catch (_) {}
        });
      }
      send(payload) {
        try { if (JSON.parse(payload).signal?.candidate) iceDiagnostics.sent += 1; } catch (_) {}
        return super.send(payload);
      }
    };
    const addCandidate = RTCPeerConnection.prototype.addIceCandidate;
    RTCPeerConnection.prototype.addIceCandidate = async function(candidate) {
      try { const result = await addCandidate.call(this, candidate); iceDiagnostics.applied += 1; return result; }
      catch (error) { iceDiagnostics.errors.push(error.message); throw error; }
    };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: (constraints) => parent.quorumMediaHarness.getUserMedia(index, constraints)
    });
    window.addEventListener('error', (event) => parent.quorumMediaHarness.error(index, event.message));
    window.addEventListener('unhandledrejection', (event) => parent.quorumMediaHarness.error(index, String(event.reason)));
  }

  function appApi() {
    S.gesture.wanted = false;
    stopServerProbe();
    window.quorumTest = {
      state: S,
      async prepare(code) { S.roomId = code; await acquireMedia(); },
      join: (code, name, minted) => joinRoom(code, name, minted, {}),
      leave() { leaveSpace({ silent: true }); stopServerProbe(); },
      snapshot() {
        const remote = document.querySelector('.q-box:not(.self) video');
        const audio = document.querySelector('.q-box:not(.self) audio');
        return {
          id: S.selfId, joined: S.joined, iceDiagnostics: { ...window.quorumIceDiagnostics }, local: S.localStream?.getTracks().map((t) => ({ kind: t.kind, ready: t.readyState, enabled: t.enabled })) || [],
          peers: [...S.peers.values()].map((peer) => ({
            id: peer.id, connection: peer.pc.connectionState, signaling: peer.pc.signalingState,
            ice: peer.pc.iceConnectionState, gathering: peer.pc.iceGatheringState,
            localCandidates: (peer.pc.localDescription?.sdp.match(/^a=candidate:/gm) || []).length,
            transceivers: peer.pc.getTransceivers().map((t) => ({ mid: t.mid, direction: t.direction, currentDirection: t.currentDirection, kind: t.receiver.track.kind, sending: t.sender.track?.kind || null })),
            remoteTracks: peer.remoteStream.getTracks().map((t) => ({ kind: t.kind, muted: t.muted, ready: t.readyState }))
          })),
          remoteVideo: remote ? { width: remote.videoWidth, height: remote.videoHeight, paused: remote.paused, muted: remote.muted, ready: remote.readyState, currentTime: remote.currentTime, hasStream: !!remote.srcObject } : null,
          remoteAudio: audio ? { paused: audio.paused, muted: audio.muted, ready: audio.readyState, currentTime: audio.currentTime, hasStream: !!audio.srcObject, liveAudioTracks: audio.srcObject?.getAudioTracks().filter((track) => track.readyState === 'live').length || 0 } : null,
          audioBlocked: S.blockedPlayback.size > 0,
          enableAudioVisible: !!E.qEnableAudioBtn && !E.qEnableAudioBtn.hidden
        };
      },
      async stats() {
        const peer = [...S.peers.values()][0];
        if (!peer) return {};
        const totals = { connection: peer.pc.connectionState, inbound: { audio: 0, video: 0 }, outbound: { audio: 0, video: 0 }, decodedFrames: 0, audioEnergy: 0 };
        for (const item of (await peer.pc.getStats()).values()) {
          const kind = item.kind || item.mediaType;
          if (item.type === 'inbound-rtp' && kind in totals.inbound) {
            totals.inbound[kind] += item.bytesReceived || 0;
            if (kind === 'video') totals.decodedFrames += item.framesDecoded || 0;
            if (kind === 'audio') totals.audioEnergy += item.totalAudioEnergy || 0;
          }
          if (item.type === 'outbound-rtp' && kind in totals.outbound) totals.outbound[kind] += item.bytesSent || 0;
        }
        return totals;
      }
    };
  }

  const errors = [];
  window.quorumMediaHarness = {
    getUserMedia: (index, constraints) => inputs[index].getUserMedia(constraints),
    error: (index, message) => errors.push({ participant: index + 1, message }),
    markup: (index) => preparedMarkup[index]
  };

  async function createClient(index) {
    htmlPromise ||= fetch('/quorum/index.html').then((response) => {
      if (!response.ok) throw new Error(`Cannot load production client: HTTP ${response.status}`);
      return response.text();
    });
    const original = await htmlPromise;
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/quorum-space`;
    const setup = `<base href="${location.origin}/quorum/"><script>(${bridge.toString()})(${index},${JSON.stringify(wsUrl)})<\/script>`;
    const api = `<script>(${appApi.toString()})();<\/script>`;
    const frame = document.createElement('iframe');
    frame.title = `Quorum participant ${index + 1}`;
    frame.allow = 'autoplay; camera; microphone';
    preparedMarkup[index] = original.replace('<head>', `<head>${setup}`).replace('</body>', `${api}</body>`);
    // A real same-origin document preserves location.host, unlike about:srcdoc.
    // The loader writes the prepared production markup without changing its URL.
    frame.src = `./media-client.html?index=${index}`;
    clients.append(frame);
    frames.push(frame);
    await until(() => frame.contentWindow?.quorumTest, `participant ${index + 1} app boot`);
    return frame.contentWindow.quorumTest;
  }

  async function cleanup() {
    for (const frame of frames) {
      try { frame.contentWindow.quorumTest?.leave(); } catch (_) { /* failed boot */ }
      frame.remove();
    }
    frames = [];
    for (const input of inputs) input.close();
    inputs = [];
    await delay(100);
  }

  function connected(client) {
    return client.state.joined && client.state.peers.size === 1 && [...client.state.peers.values()][0].pc.connectionState === 'connected';
  }

  async function runScenario(scenario, number) {
    const code = `media-test-${Date.now()}-${number}`;
    inputs = scenario.inputs.map((config, index) => inputSource(index, config));
    const [a, b] = await Promise.all([createClient(0), createClient(1)]);
    const pair = [a, b];
    for (let index = 0; index < pair.length; index += 1) {
      if (scenario.inputs[index].prepare) await pair[index].prepare(code);
    }
    await a.join(code, 'Media test A', true);
    await until(() => a.state.joined, 'first participant joins');
    await b.join(code, 'Media test B', false);
    await until(() => pair.every(connected), 'actual peer connection before delayed permissions');
    let whileCameraPermissionPending = null;
    if (scenario.inputs.some((input) => input.pendingCamera)) {
      await until(async () => {
        for (let index = 0; index < pair.length; index += 1) {
          const totals = await pair[index].stats();
          if (!totals.inbound?.audio || !totals.outbound?.audio || totals.audioEnergy <= 0) return false;
          if (scenario.inputs[index].pendingCamera) {
            const tracks = pair[index].state.localStream?.getTracks() || [];
            if (!tracks.some((track) => track.kind === 'audio')) return false;
            assert(!tracks.some((track) => track.kind === 'video'), `Participant ${index + 1} camera should still await permission`);
          }
        }
        return true;
      }, 'two-way audio while the camera permission prompt is pending');
      const audioBefore = await Promise.all(pair.map((client) => client.stats()));
      await delay(700);
      const audioAfter = await Promise.all(pair.map((client) => client.stats()));
      for (let index = 0; index < pair.length; index += 1) {
        assert(audioAfter[index].inbound.audio > audioBefore[index].inbound.audio && audioAfter[index].outbound.audio > audioBefore[index].outbound.audio, `Participant ${index + 1} audio stopped while camera permission was pending`);
        assert(audioAfter[index].audioEnergy > audioBefore[index].audioEnergy, `Participant ${index + 1} received silent audio while camera permission was pending`);
      }
      whileCameraPermissionPending = { ui: pair.map((client) => client.snapshot()), audioBefore, audioAfter };
    }
    const beforePermission = pair.map((client) => client.snapshot());
    for (let index = 0; index < inputs.length; index += 1) {
      if (scenario.inputs[index].pending) {
        assert(!pair[index].state.localStream?.getTracks().length, `Participant ${index + 1} should still be awaiting permission`);
        inputs[index].release();
      }
      if (scenario.inputs[index].pendingCamera) inputs[index].release();
    }
    await until(() => pair.every((client, index) => {
      const tracks = client.state.localStream?.getTracks() || [];
      return tracks.some((track) => track.kind === 'audio') && (scenario.inputs[index].denyCamera || tracks.some((track) => track.kind === 'video'));
    }), 'device acquisition');
    const shouldSendVideo = scenario.inputs.map((input) => !input.denyCamera);
    const enoughMedia = async () => {
      for (let index = 0; index < pair.length; index += 1) {
        const totals = await pair[index].stats();
        if (!totals.inbound?.audio || !totals.outbound?.audio || totals.audioEnergy <= 0) return false;
        if (shouldSendVideo[index] && !totals.outbound.video) return false;
        if (shouldSendVideo[1 - index] && (!totals.inbound.video || totals.decodedFrames < 2 || !pair[index].snapshot().remoteVideo?.width)) return false;
      }
      return true;
    };
    await until(enoughMedia, 'non-silent audio and decoded remote video');
    const baseline = await Promise.all(pair.map((client) => client.stats()));
    const baselineUi = pair.map((client) => client.snapshot());
    await delay(1300);
    const after = await Promise.all(pair.map((client) => client.stats()));
    const ui = pair.map((client) => client.snapshot());
    for (let index = 0; index < pair.length; index += 1) {
      assert(after[index].connection === 'connected', `Participant ${index + 1} disconnected`);
      for (const direction of ['inbound', 'outbound']) {
        assert(after[index][direction].audio > baseline[index][direction].audio, `Participant ${index + 1} ${direction} audio bytes stopped`);
      }
      assert(after[index].audioEnergy > baseline[index].audioEnergy, `Participant ${index + 1} remote audio is silent`);
      if (shouldSendVideo[index]) assert(after[index].outbound.video > baseline[index].outbound.video, `Participant ${index + 1} outgoing video stopped`);
      if (shouldSendVideo[1 - index]) {
        assert(after[index].inbound.video > baseline[index].inbound.video, `Participant ${index + 1} incoming video stopped`);
        assert(after[index].decodedFrames > baseline[index].decodedFrames, `Participant ${index + 1} remote frames stopped decoding`);
        assert(ui[index].remoteVideo?.currentTime > baselineUi[index].remoteVideo?.currentTime, `Participant ${index + 1} rendered remote video is frozen`);
      }
      assert(ui[index].remoteVideo?.hasStream, `Participant ${index + 1} remote stream was not attached to its tile`);
      assert(ui[index].remoteVideo?.muted, `Participant ${index + 1} video should autoplay independently of sound`);
      assert(ui[index].remoteAudio?.hasStream && ui[index].remoteAudio.liveAudioTracks > 0, `Participant ${index + 1} remote audio has no live audio stream`);
      assert(!ui[index].remoteAudio?.muted, `Participant ${index + 1} remote audio is muted`);
      if (ui[index].remoteAudio?.paused) {
        assert(ui[index].audioBlocked && ui[index].enableAudioVisible, `Participant ${index + 1} browser-blocked sound has no visible recovery control`);
      } else {
        assert(ui[index].remoteAudio.currentTime > baselineUi[index].remoteAudio?.currentTime, `Participant ${index + 1} remote audio playback stopped`);
      }
    }
    return { scenario: scenario.name, beforePermission, whileCameraPermissionPending, baseline, after, ui, errors: [...errors] };
  }

  button.addEventListener('click', async () => {
    button.disabled = true;
    results.replaceChildren();
    errors.length = 0;
    const report = [];
    window.quorumMediaResults = { state: 'running', report };
    try {
      assert(window.isSecureContext, 'Use http://localhost or HTTPS for real WebRTC');
      assert(typeof RTCPeerConnection === 'function', 'This browser does not support WebRTC');
      audioContext = new AudioContext();
      await audioContext.resume();
      assert(audioContext.state === 'running', 'Click Run tests to enable synthesized audio');
      const scenarios = [
        { name: 'Both participants grant media before peers connect', inputs: [{ prepare: true }, { prepare: true }] },
        { name: 'Joining participant grants permissions after peers connect', inputs: [{ prepare: true }, { pending: true }] },
        { name: 'Room host grants permissions after peers connect', inputs: [{ pending: true }, { prepare: true }] },
        { name: 'Camera denied: two-way audio and incoming video still work', inputs: [{ denyCamera: true, prepare: true }, { prepare: true }] },
        { name: 'Camera permission pending: audio works first, then video arrives', inputs: [{ prepare: true }, { pendingCamera: true }] }
      ];
      for (let index = 0; index < scenarios.length; index += 1) {
        const scenario = scenarios[index];
        status.textContent = `Running ${index + 1}/${scenarios.length}`;
        const row = document.createElement('li');
        row.textContent = `Running: ${scenario.name}`;
        results.append(row);
        try {
          const result = await runScenario(scenario, index);
          report.push({ passed: true, ...result });
          row.className = 'pass';
          row.textContent = `PASS: ${scenario.name}\nIncreasing RTP audio/video bytes, remote audio energy, and rendered frames verified.${result.whileCameraPermissionPending ? '\nTwo-way audio verified while the camera permission remained pending.' : ''}`;
        } catch (error) {
          const result = { passed: false, scenario: scenario.name, error: error.stack || String(error), errors: [...errors], clients: frames.map((frame) => frame.contentWindow.quorumTest?.snapshot()) };
          report.push(result);
          row.className = 'fail';
          row.textContent = `FAIL: ${scenario.name}\n${error.message}`;
        } finally {
          diagnostics.textContent = JSON.stringify(report, null, 2);
          await cleanup();
        }
      }
      const passed = report.filter((result) => result.passed).length;
      status.textContent = `${passed}/${scenarios.length} passed`;
      window.quorumMediaResults.state = passed === scenarios.length ? 'passed' : 'failed';
    } catch (error) {
      status.textContent = `Failed: ${error.message}`;
      diagnostics.textContent = error.stack || String(error);
      window.quorumMediaResults.state = 'failed';
    } finally {
      await cleanup();
      await audioContext?.close();
      button.disabled = false;
    }
  });
})();
