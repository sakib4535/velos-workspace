'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { createRtcConfigProvider } = require('../rtc-config');

const cloudflareEnv = { TURN_KEY_ID: 'example-key-id', TURN_KEY_API_TOKEN: 'server-only-api-token' };
const providerServers = [
  { urls: ['stun:stun.cloudflare.com:3478'] },
  {
    urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
    username: 'temporary-username', credential: 'temporary-credential'
  }
];
const successfulResponse = () => ({ ok: true, status: 201, json: async () => ({ iceServers: providerServers }) });

test('Cloudflare TURN credentials use the documented server API and expose only client ICE fields', async () => {
  let request;
  const getConfig = createRtcConfigProvider({
    env: cloudflareEnv,
    fetch: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ iceServers: providerServers, apiToken: cloudflareEnv.TURN_KEY_API_TOKEN }) };
    }
  });
  const config = await getConfig();
  assert.equal(request.url, 'https://rtc.live.cloudflare.com/v1/turn/keys/example-key-id/credentials/generate-ice-servers');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, `Bearer ${cloudflareEnv.TURN_KEY_API_TOKEN}`);
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request.options.body), { ttl: 21600 });
  assert.equal(request.options.signal.aborted, false);
  assert.deepEqual(config.iceServers.slice(1), providerServers);
  assert.deepEqual(config.relay, { configured: true, available: true, provider: 'cloudflare', status: 'ready' });
  assert.ok(!JSON.stringify(config).includes(cloudflareEnv.TURN_KEY_API_TOKEN));
  assert.ok(!JSON.stringify(config).includes(cloudflareEnv.TURN_KEY_ID));
});

test('simultaneous config requests deduplicate issuance and short cache replies cannot mutate shared credentials', async () => {
  let completeRequest;
  let calls = 0;
  const getConfig = createRtcConfigProvider({
    env: cloudflareEnv,
    fetch: () => {
      calls += 1;
      return new Promise((resolve) => { completeRequest = resolve; });
    }
  });
  const first = getConfig();
  const second = getConfig();
  assert.equal(calls, 1);
  completeRequest(successfulResponse());
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  a.iceServers[2].credential = 'mutated';
  assert.equal(b.iceServers[2].credential, 'temporary-credential');
  assert.equal((await getConfig()).iceServers[2].credential, 'temporary-credential');
  assert.equal(calls, 1);
});

test('cached credentials refresh before expiration and also after the brief issuance cache window', async () => {
  let clock = 100000;
  let calls = 0;
  const getConfig = createRtcConfigProvider({
    env: { ...cloudflareEnv, TURN_TTL_SECONDS: '60' }, now: () => clock,
    fetch: async () => { calls += 1; return successfulResponse(); }
  });
  await getConfig();
  clock += 44999;
  await getConfig();
  assert.equal(calls, 1);
  clock += 2;
  await getConfig();
  assert.equal(calls, 2, 'A 60-second credential must refresh with time remaining before expiry');

  const longerLived = createRtcConfigProvider({
    env: cloudflareEnv, now: () => clock,
    fetch: async () => { calls += 1; return successfulResponse(); }
  });
  await longerLived();
  clock += 60001;
  await longerLived();
  assert.equal(calls, 4, 'Longer-lived credentials still use only a brief server cache');
});

test('TURN lifetime defaults and clamps apply to provider-issued credentials', async () => {
  for (const [value, expected] of [[undefined, 21600], ['invalid', 21600], ['0', 21600], ['1', 60], ['999999', 86400], ['120.9', 120]]) {
    let requestedTtl;
    const getConfig = createRtcConfigProvider({
      env: { ...cloudflareEnv, TURN_TTL_SECONDS: value },
      fetch: async (_, options) => { requestedTtl = JSON.parse(options.body).ttl; return successfulResponse(); }
    });
    await getConfig();
    assert.equal(requestedTtl, expected);
  }
});

test('static TURN and coturn shared-secret credentials remain available without Cloudflare', async () => {
  let calls = 0;
  const fetch = async () => { calls += 1; throw new Error('Must not contact provider'); };
  const staticConfig = await createRtcConfigProvider({
    env: { TURN_URLS: 'turn:relay.example:3478, invalid, turns:relay.example:443?transport=tcp', TURN_USERNAME: 'client', TURN_CREDENTIAL: 'client-credential' }, fetch
  })();
  assert.deepEqual(staticConfig.iceServers[1], {
    urls: ['turn:relay.example:3478', 'turns:relay.example:443?transport=tcp'],
    username: 'client', credential: 'client-credential'
  });
  assert.equal(staticConfig.relay.provider, 'static');
  assert.equal(staticConfig.relay.available, true);

  const secret = 'server-only-shared-secret';
  const coturnConfig = await createRtcConfigProvider({
    env: { TURN_URLS: 'turn:relay.example:3478', TURN_SHARED_SECRET: secret, TURN_TTL_SECONDS: '120' },
    now: () => 1000000, fetch
  })();
  assert.equal(coturnConfig.iceServers[1].username, '1120:quorum');
  assert.equal(coturnConfig.iceServers[1].credential, crypto.createHmac('sha1', secret).update('1120:quorum').digest('base64'));
  assert.equal(coturnConfig.relay.provider, 'coturn');
  assert.ok(!JSON.stringify(coturnConfig).includes(secret));
  assert.equal(calls, 0);
});

test('provider failures preserve a configured static relay and expose a safe cached error status', async () => {
  let calls = 0;
  let clock = 100000;
  const getConfig = createRtcConfigProvider({
    env: { ...cloudflareEnv, TURN_URLS: 'turn:backup.example:3478', TURN_USERNAME: 'backup-user', TURN_CREDENTIAL: 'backup-credential' },
    now: () => clock,
    fetch: async () => { calls += 1; throw new Error(`Request failed: ${cloudflareEnv.TURN_KEY_API_TOKEN}`); }
  });
  const config = await getConfig();
  assert.deepEqual(config.relay, { configured: true, available: true, provider: 'static', status: 'fallback', error: 'provider-unavailable' });
  assert.equal(config.iceServers[1].username, 'backup-user');
  assert.ok(!JSON.stringify(config).includes(cloudflareEnv.TURN_KEY_API_TOKEN));
  await getConfig();
  assert.equal(calls, 1, 'Failures also use a short cache to avoid repeated provider requests');
  clock += 10001;
  await getConfig();
  assert.equal(calls, 2);
});

test('malformed, missing-relay and unauthorized provider responses fall back to STUN with an explicit error', async () => {
  const responses = [
    [{ ok: false, json: async () => ({ secret: cloudflareEnv.TURN_KEY_API_TOKEN }) }, 'provider-rejected'],
    [{ ok: true, json: async () => { throw new Error('Invalid JSON'); } }, 'provider-invalid-response'],
    [{ ok: true, json: async () => ({ iceServers: { urls: 'turn:relay.example:3478' } }) }, 'provider-invalid-response'],
    [{ ok: true, json: async () => ({ iceServers: [{ urls: ['stun:relay.example:3478'] }] }) }, 'provider-invalid-response'],
    [{ ok: true, json: async () => ({ iceServers: [{ urls: ['turn:relay.example:3478'], username: 'user' }] }) }, 'provider-invalid-response']
  ];
  for (const [response, code] of responses) {
    const config = await createRtcConfigProvider({ env: cloudflareEnv, fetch: async () => response })();
    assert.equal(config.iceServers.length, 1);
    assert.deepEqual(config.relay, { configured: true, available: false, provider: 'cloudflare', status: 'error', error: code });
    assert.ok(!JSON.stringify(config).includes(cloudflareEnv.TURN_KEY_API_TOKEN));
  }
});

test('provider timeout aborts both a stalled request and a stalled JSON response within the client configuration deadline', async () => {
  for (const stallBody of [false, true]) {
    let signal;
    const getConfig = createRtcConfigProvider({
      env: cloudflareEnv, timeoutMs: 15,
      fetch: async (_, options) => {
        signal = options.signal;
        return stallBody ? { ok: true, json: () => new Promise(() => {}) } : new Promise(() => {});
      }
    });
    const config = await getConfig();
    assert.equal(signal.aborted, true);
    assert.equal(config.relay.error, 'provider-timeout');
    assert.equal(config.relay.available, false);
  }
});

test('absent or incomplete relay setup is reported without calling an external provider', async () => {
  let calls = 0;
  const fetch = async () => { calls += 1; return successfulResponse(); };
  const absent = await createRtcConfigProvider({ env: {}, fetch })();
  assert.deepEqual(absent.relay, { configured: false, available: false, status: 'not-configured' });
  const incomplete = await createRtcConfigProvider({ env: { TURN_KEY_ID: 'example-id' }, fetch })();
  assert.deepEqual(incomplete.relay, { configured: true, available: false, provider: 'cloudflare', status: 'error', error: 'credentials-incomplete' });
  const missingStaticCredentials = await createRtcConfigProvider({ env: { TURN_URLS: 'turn:relay.example:3478' }, fetch })();
  assert.equal(missingStaticCredentials.relay.status, 'incomplete');
  assert.equal(missingStaticCredentials.relay.available, false);
  assert.equal(calls, 0);
});
