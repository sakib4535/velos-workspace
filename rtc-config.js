'use strict';

const crypto = require('node:crypto');

const STUN_URLS = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

function credentialTtl(value) {
  const ttl = Number(value);
  return Math.max(60, Math.min(86400, Math.floor(Number.isFinite(ttl) && ttl > 0 ? ttl : 21600)));
}

function configuredText(value) { return String(value || '').trim(); }

function staticRelay(env, now, ttl) {
  const urls = configuredText(env.TURN_URLS).split(',').map((url) => url.trim())
    .filter((url) => /^turns?:[^\s]+$/i.test(url));
  if (!urls.length) return null;
  if (env.TURN_SHARED_SECRET) {
    const username = `${Math.floor(now / 1000) + ttl}:quorum`;
    const credential = crypto.createHmac('sha1', env.TURN_SHARED_SECRET).update(username).digest('base64');
    return { urls, username, credential };
  }
  if (env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    return { urls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL };
  }
  return null;
}

function providerError(code) {
  const error = new Error(code);
  error.relayCode = code;
  return error;
}

function sanitizeProviderServers(value) {
  if (!Array.isArray(value)) throw providerError('provider-invalid-response');
  const servers = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const urls = (Array.isArray(item.urls) ? item.urls : [item.urls])
      .filter((url) => typeof url === 'string' && /^(?:stun|stuns|turn|turns):[^\s]+$/i.test(url));
    if (!urls.length) continue;
    const hasRelay = urls.some((url) => /^turns?:/i.test(url));
    if (hasRelay && (typeof item.username !== 'string' || !item.username ||
        typeof item.credential !== 'string' || !item.credential)) continue;
    servers.push(hasRelay ? { urls, username: item.username, credential: item.credential } : { urls });
  }
  if (!servers.some((server) => server.urls.some((url) => /^turns?:/i.test(url)))) {
    throw providerError('provider-invalid-response');
  }
  return servers;
}

/**
 * Builds browser-safe ICE configuration. Provider API tokens and coturn shared
 * secrets stay on the server; only temporary/client TURN credentials are public.
 * Cloudflare API: https://developers.cloudflare.com/realtime/turn/generate-credentials/
 */
function createRtcConfigProvider({
  env = process.env, fetch: fetchImplementation = globalThis.fetch,
  now = Date.now, timeoutMs = 2500, cacheMs = 60000, failureCacheMs = 10000
} = {}) {
  const ttl = credentialTtl(env.TURN_TTL_SECONDS);
  const keyId = configuredText(env.TURN_KEY_ID);
  const apiToken = configuredText(env.TURN_KEY_API_TOKEN);
  const cloudflareConfigured = Boolean(keyId || apiToken);
  const staticConfigured = Boolean(env.TURN_URLS || env.TURN_SHARED_SECRET || env.TURN_USERNAME || env.TURN_CREDENTIAL);
  const providerTimeout = Math.max(1, Math.min(3000, Number(timeoutMs) || 2500));
  let cached = null;
  let inFlight = null;

  async function fetchCloudflareServers() {
    if (typeof fetchImplementation !== 'function') throw providerError('provider-unavailable');
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImplementation(
            `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ ttl }), signal: controller.signal
            }
          );
          if (!response.ok) throw providerError('provider-rejected');
          let data;
          try { data = await response.json(); }
          catch (_) { throw providerError('provider-invalid-response'); }
          return sanitizeProviderServers(data?.iceServers);
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(providerError('provider-timeout'));
            controller.abort();
          }, providerTimeout);
        })
      ]);
    } finally { clearTimeout(timer); }
  }

  function fallback(error) {
    const relay = staticRelay(env, now(), ttl);
    const configured = cloudflareConfigured || staticConfigured;
    return {
      iceServers: [{ urls: [...STUN_URLS] }, ...(relay ? [relay] : [])],
      relay: {
        configured, available: Boolean(relay),
        ...(relay ? { provider: env.TURN_SHARED_SECRET ? 'coturn' : 'static' } :
          cloudflareConfigured ? { provider: 'cloudflare' } : {}),
        status: error ? (relay ? 'fallback' : 'error') : relay ? 'ready' : configured ? 'incomplete' : 'not-configured',
        ...(error ? { error } : {})
      }
    };
  }

  return async function publicRtcConfig() {
    if (!cloudflareConfigured) return fallback();
    if (!keyId || !apiToken) return fallback('credentials-incomplete');
    if (cached && now() < cached.refreshAt) return structuredClone(cached.config);
    if (inFlight) return structuredClone(await inFlight);
    inFlight = (async () => {
      const requestedAt = now();
      try {
        const servers = await fetchCloudflareServers();
        const config = fallback();
        config.iceServers.push(...servers);
        config.relay = { configured: true, available: true, provider: 'cloudflare', status: 'ready' };
        const expiryMarginMs = Math.min(30000, ttl * 250);
        cached = {
          config,
          refreshAt: Math.min(now() + Math.max(0, cacheMs), requestedAt + ttl * 1000 - expiryMarginMs)
        };
      } catch (error) {
        cached = { config: fallback(error.relayCode || 'provider-unavailable'), refreshAt: now() + Math.max(0, failureCacheMs) };
      }
      return cached.config;
    })();
    try { return structuredClone(await inFlight); }
    finally { inFlight = null; }
  };
}

module.exports = { createRtcConfigProvider };
