/* Optional deployment overrides. A Node deployment uses its own server;
 * a static website falls back to the shared Render signaling service.
 * Set wsUrl for a dedicated backend, and rtcConfig.iceServers for TURN.
 */
'use strict';

window.QUORUM_CONFIG = window.QUORUM_CONFIG || {};
