# Velos + Quorum

Velos is a hand-gesture presentation workspace. Quorum is the companion meeting space for small-group facilitation, host-arranged participant boxes, ballots, and gesture voting.

## Start

Requires Node.js 18.11 or newer.

    npm install
    npm run build
    npm start

Open http://localhost:8788. Use **Velos Quorum** to open a space or use **Velos Presenter** for the gesture-controlled slide workspace. Quorum rooms require the server; do not open an HTML file directly from File Explorer. If port 8788 is already occupied, stop the older server or choose another port. In Windows Command Prompt, use: `set PORT=8898 && npm start`, then open `http://localhost:8898`. In PowerShell, use: `$env:PORT=8898; npm.cmd start`, then open `http://localhost:8898`.

In Windows PowerShell, use `npm.cmd install` and `npm.cmd start` if the `npm` command is blocked by script execution policy. Keep the terminal open while using Quorum. The join screen retries server detection automatically. If you opened the page through a local preview on another port, the client also checks the Quorum server at `localhost:8788` after a short timeout. Local and LAN deployments use their own server.

## Public deployment and room invitations

The project includes a Render Blueprint in `render.yaml`. Deploy the Node service in Render as well as deploying the website to Vercel; Vercel alone does not run the persistent Quorum WebSocket server. After Render finishes deploying, open its `/healthz` endpoint and confirm it returns JSON with `status: ok`. Render supplies HTTPS and routes WebSocket connections through the same public service. The app listens on Render's `PORT`. Quorum first checks its own origin; public static websites fall back to `wss://velos-workspace.onrender.com/quorum-space`. A Render-hosted page always uses its own Render service. To use a different dedicated signaling server, set `window.QUORUM_CONFIG.wsUrl` in `quorum/quorum-config.js`. Once joined, reconnects stay pinned to that backend so participants cannot be split across servers. A sleeping free service is given up to 90 seconds to wake.

After deployment, open the public `/quorum/` page, create a room, and use **Invite** in the room header. The copied URL opens the same deployment with that room code prefilled; each guest enters a name and selects **Join with code**. Guests need browser access to camera/microphone if they want to use video. In **Tools**, open a platform tile in its own tab, return to Quorum, and choose **Share with Quorum**. Pick that tab to present it. Full-display sharing works for presenting; host-approved ShareView remote control is available only when the Node server runs on the Windows computer being controlled, so it is not available from a Render-hosted service.

The included Blueprint uses Render's free plan. Free services can sleep after inactivity, and this app keeps active room state in memory, so a server restart ends current rooms. For sessions that must start promptly, configure an always-on service and keep it at one instance: room state is local to the running server, so horizontal scaling is not configured. The app currently has no accounts or private-room password; anyone with an invite link can attempt to join. Peer-to-peer video may need a TURN relay on restrictive networks.

### Connection recovery and TURN

The server uses protocol heartbeats, including for background tabs. After a connection drops, the browser retries with capped backoff and resumes the same participant, host role, group and ballot state for up to 90 seconds. Camera and healthy peer streams stay active through a signaling interruption. A page refresh uses a private resume token in that tab's session storage; selecting **Leave** removes it and exits immediately. Incomplete WebRTC negotiations are rebuilt after reconnect; disconnected media connections exchange new ICE offers.

For networks that block direct media, configure a TURN service on the Node server using environment variables:

- `TURN_KEY_ID` and `TURN_KEY_API_TOKEN`: optional Cloudflare Realtime TURN key and server API token. The server requests temporary ICE credentials, caches short-lived responses, and keeps the API token out of the browser.
- `TURN_URLS`: comma-separated relay URLs, such as `turn:your-relay.example:3478,turns:your-relay.example:5349?transport=tcp`.
- `TURN_SHARED_SECRET`: the coturn REST shared secret, used only on the server to issue expiring credentials. Optional `TURN_TTL_SECONDS` defaults to 21600.
- Alternatively, set `TURN_USERNAME` and `TURN_CREDENTIAL` for an existing relay account.

`GET /quorum-config` supplies the browser with STUN and configured TURN servers. The shared secret is never returned. A deployment can also supply `window.QUORUM_CONFIG.rtcConfig` directly. Without a working TURN service, restrictive networks may still block audio/video. Network quality, device speed, service uptime, and the peer mesh's participant count affect latency; the application cannot guarantee zero drops or lag.

### Participants appear as boxes but have no audio/video

Room membership and media use separate connections. A successful room join does not prove that audio/video can pass between different internet connections. Deploy the current client to Vercel and the Node service to Render together. The client assigns the initial media offer to one participant, adopts the offered audio/video senders on the other side, and attaches each camera/microphone immediately when its permission finishes. A pending or denied camera does not block the microphone. The camera and microphone controls retry device access after permission changes.

For `https://velos-workspace.vercel.app/`, set your TURN provider's `TURN_URLS`, `TURN_USERNAME`, and `TURN_CREDENTIAL` on the **velos-workspace Render service**, or use `TURN_SHARED_SECRET` for coturn. Include your provider's supported TLS/TCP endpoint for networks that block UDP. `.env.example` lists the supported settings; it is a reference file, not an automatically loaded configuration. Do not put shared secrets or permanent provider API keys in the browser configuration. The Render `/quorum-config` response must include a `turn:` or `turns:` entry before relay connections are available.

If you do not have a relay yet, the optional [Cloudflare Realtime TURN integration](https://developers.cloudflare.com/realtime/turn/generate-credentials/) requires two settings:

1. In your Cloudflare account, create a Realtime TURN key and its API token. Review the [current pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/) before enabling the service; the first 1,000 GB per month is currently included, with usage charges above that allowance.
2. On the **Render Node service**, add `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` as secret environment variables. Leave the alternative `TURN_URLS`, `TURN_USERNAME`, and `TURN_CREDENTIAL` empty unless intentionally configuring a fallback provider.
3. Deploy the updated Node service and Vercel website. Verify `https://velos-workspace.onrender.com/quorum-config` returns `relay.available: true` and at least one `turn:` or `turns:` URL. An HTTP 200 response alone does not mean a relay is available.
4. Refresh the Quorum page on both devices, allow camera/microphone access, and join the same room from the two internet connections. If sound is blocked by the browser, select **Enable audio**.

The code does not create a relay account or enable a paid service. Cloudflare, Render, and Vercel account access is needed to activate this setup. A missing or rejected provider credential is reported through `relay.status`; the client shows a recovery message when media cannot connect. An existing static/coturn relay remains available as fallback if Cloudflare is unavailable.

Remote video autoplays muted and remote audio plays through its own audio element. If the browser blocks sound, select **Enable audio** in the meeting header. If the network connection stalls, the meeting shows a media warning and **Retry audio/video** control instead of silently leaving only empty tiles. When no TURN relay is configured, that warning identifies the missing network fallback. A relay must be reachable and its credentials valid; the signaling server cannot replace it.

### Vercel deployment

Deploy this project folder to Vercel for the website, then deploy the Node service to Render for Quorum WebSockets and room state. Keep the Render service at one instance because active room state is held in that server process. Vercel serves the pages and static files; the Quorum browser client connects to `velos-workspace.onrender.com`. Invite links can use the Vercel website URL, while Render handles signaling and shared participant state. ShareView remote control remains Windows-host-only.

## Quorum

- The first participant is the host. Everyone can move their own participant tile around the open canvas; the host can arrange all participants into up to eight groups.
- The host can set a motion and open a timed or untimed ballot. Participants can vote with buttons or hand gestures.
- Participants may enter an optional self-reported position, rank, skillsets, and department before joining. The host sees those details with the white **+** button on a participant box; other members receive no profile fields from the server.
- On phones with front and rear cameras, use **Flip** in the call dock to switch lenses. Browsers with only one camera report that no alternate lens is available.
- Present the built-in Quorum slides or share a screen from the presentation controls.
- The shared stage offers **Fit** to show the whole screen, **Fill** to use the available stage area, and **Full screen** to expand the presentation view. Fill can crop the shared display's edges.
- **Tools** adds shared TV-style screens directly to the canvas. Anyone in the room can create, move, resize, rename, expand, and use a screen. Built-in tools include shared notes, a drawing whiteboard, task checklists, and a focus timer. **World map** adds an interactive OpenStreetMap screen.
- ShareView-inspired remote control is available only when this Node server runs on the Windows computer being shared. The host shares the full display, and must explicitly approve one participant's request. The host can revoke control at any time; control ends when sharing stops or the participant leaves.
- Remote control sends mouse and keyboard input to the Windows computer running the server. Only share with people you trust. Screen sharing requires browser permission each time. Choose the primary display to keep the shared picture aligned with the computer's cursor.

### Open canvas and working screens

Drag an empty part of the dotted canvas to pan, scroll to zoom around the pointer, or pinch with two fingers on a touchscreen. The bottom-right controls offer zoom, **Fit everyone and tools**, reset, and a pan mode. Keyboard shortcuts are `+`, `−`, `F` for fit, and `0` for reset; arrow keys pan while the canvas is focused. Your camera view is personal, while participant, group, and screen positions are shared. Positions can extend well beyond the original stage. Group panels use matching room colors and show graph connections to their members.

Use a screen's top bezel to drag it or its bottom-right handle to resize it; both handles support arrow keys and Shift for larger steps. **Expand screen** keeps its current editor intact in fullscreen. Notes, completed tasks, vector strokes, timer state, titles, and positions synchronize through the room server. Concurrent document edits preserve your draft and offer an explicit choice between your draft and the room's version.

For external tools, paste a public HTTPS website/embed URL into **Tools → Web tool**. The embedded service controls sign-in, access, collaboration, and editing. Some providers require a published/share/embed link and some prohibit framing entirely; a regular dashboard URL is not guaranteed to work. Quorum displays the frame inside the workspace and offers retry and replacement controls, without proxying the service or bypassing its restrictions. See [browser embedding restrictions](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors) and [OpenStreetMap's sharing documentation](https://wiki.openstreetmap.org/wiki/Export#Embeddable_HTML).

The room holds up to 12 screens, with bounded document size. Work survives reconnects during the meeting. Room content resets when the room empties, the host ends the session, or the server restarts; use each native screen's **Download** button to keep notes as text, checklists as Markdown, drawings as SVG, or timer state as JSON. External tools store their own work according to that provider.

### Ballot studio and productive focus

Use **Ballot studio +** in the right sidebar to open the dashboard. Anyone in the room can create up to 20 ballots per session:

- **Topic choose:** 2–6 options, single or multiple selection, with live bubbles grouped around each choice. Each selection gets a bubble; multi-choice voters may appear in several clusters. The spatial design is not an SVM model or a confidence score.
- **Multipolar decision:** rate 3–6 criteria from 1 to 5. A radar shows the room's mean on each axis and an optional outline of your own submitted response.
- **Five-point agreement:** Yes, Somewhat yes, Don’t know, Somewhat no, No. Live bars show counts; uncertainty remains a separate category.

The server captures the connected electorate when a ballot opens. Each eligible person has one revisable response, preserved across authenticated socket resume. Late arrivals can view results. The ballot creator, host, or host-appointed co-facilitator can close voting and record a decision or next step. Download aggregate results as JSON. Names and participant IDs are omitted from the plotted responses; live updates can still allow inferences in small groups, so the UI makes that limitation explicit. This is room-level voting, not verified real-world identity or secret-ballot infrastructure.

**Thinking together** replaces the visible activity score with a shared objective, actual checklist completion and closed-ballot counts. The host can appoint one co-facilitator; both can update the objective and open or close voluntary check-ins. Participants may choose **I’m clear**, **I need context**, or **I need a pause**, revise, withdraw, or skip. While collecting, the server exposes only each person's own response. After closing, a single batch of grouped counts is published only with at least three responses, then individual answers are cleared. Smaller check-ins reveal no counts. Suggestions encourage a recap or a pause for the entire room. Nothing claims to detect attention from cameras, silence, gestures, tab usage, or response speed. No individual focus ratings or rankings are displayed.

Leaving shows the shared objective, task progress and recorded next steps, with a text download. Room documents, ballots and check-ins are held in server memory and expire when the room empties or the server restarts; download work you want to keep. The older pure scoring modules and their protocol remain for compatibility with older clients, but energy, grades and streaks are no longer shown by the current UI.

Use **Room studio**, the edge handle, or the close button to slide the sidebar in or out. Touch swipes remain available. Ballots expand over the meeting area on small screens and can be minimized without closing voting. The Uiverse grid pattern is adapted under MIT; see `THIRD_PARTY_NOTICES.md` for attribution. New logic lives in `lib/decisions.cjs`, `quorum/decisions.mjs`, and `quorum/decisions.css`.

## Requirements and limits

- Camera, microphone, and screen capture need a secure browser context (localhost or HTTPS) and individual browser permission.
- Gesture detection loads MediaPipe from a CDN, so gesture features need internet access. It processes resized camera frames in a worker when supported, with one inference in flight and an adaptive 8–24 FPS budget. GPU tracking falls back to CPU; browsers without worker support use a bounded main-thread fallback. Models are reused when tracking pauses. Manual voting and mouse dragging do not need hand tracking.
- Media uses peer-to-peer WebRTC. Some networks need a TURN relay; configure one before relying on restrictive networks.
- Room state lives in server memory and resets when the server restarts or the room empties. There are no accounts or persistent room storage.
- The local server accepts up to 16 participants and eight groups per room. Set PORT to choose another listen port.

## Validation

Run `npm run check` for syntax validation, `npm run typecheck` for the plain TypeScript modules, and `npm test` for energy, points, server, client connection/WebRTC, and gesture regression tests. Server tests start a temporary loopback server. Gesture tests use synthetic landmarks and mocked camera/model outputs; verify camera permissions, real hand poses, GPU support, and multi-device calls on the browsers and networks used for meetings.

For actual WebRTC media verification, start the Node server and open `/tests/media-browser.html`, then select **Run tests**. It runs the production Quorum client in two browser frames using generated camera frames and audio tones. Passing requires increasing received/sent audio/video bytes, nonzero received audio energy, and advancing decoded/rendered video. Scenarios cover media ready before joining, permission delays on either side, a denied camera, and audio continuing while camera permission is pending. It requests no physical camera or microphone access. This verifies browser transport and playback locally; test participants on different internet connections with the configured TURN service before a live meeting.

## Project structure

- index.html and velos-face-login.js: Velos landing page.
- app/: the active Velos presenter page, styles, and hand-tracking integration.
- quorum/: the Quorum page, styles, and meeting client.
- quorum/canvas-space.js: framework-free pan/zoom camera and world-coordinate helpers.
- quorum/workspace-tools.mjs: shared in-room tool screens, editors, downloads, and draft reconciliation.
- server.js: static hosting, room state, WebSocket signaling, and host-authorized remote-control input.
- remote-input.js: Windows-only local input bridge, started only after the host approves a control request.
