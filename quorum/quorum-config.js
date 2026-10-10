/*
 * Room signaling configuration.
 *
 * The Vercel page uses the Render room service so every participant shares
 * the same in-memory room and WebSocket relay. Render-hosted pages reuse
 * their current host; Vercel and other hosts use the configured Render URL.
 */
'use strict';

window.QUORUM_CONFIG = window.QUORUM_CONFIG || {};

const quorumIsLocal = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
if (!window.QUORUM_CONFIG.wsUrl && !quorumIsLocal) {
  const renderHost = location.hostname.endsWith('.onrender.com')
    ? location.host
    : 'velos-workspace.onrender.com';
  window.QUORUM_CONFIG.wsUrl = `wss://${renderHost}/quorum-space`;
}
