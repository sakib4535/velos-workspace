/*
 * Room signaling configuration.
 *
 * The Vercel page uses the Render room service so every participant shares
 * the same in-memory room and WebSocket relay. If Render assigns a different
 * public hostname, update this URL before deploying the Vercel site.
 */
'use strict';

window.QUORUM_CONFIG = window.QUORUM_CONFIG || {};

const quorumIsLocal = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
if (!window.QUORUM_CONFIG.wsUrl && !quorumIsLocal) {
  window.QUORUM_CONFIG.wsUrl = 'wss://velos-quorum.onrender.com/quorum-space';
}
