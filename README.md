# Velos + Quorum

Velos is a hand-gesture presentation workspace. Quorum is the companion meeting space for small-group facilitation, host-arranged participant boxes, ballots, and gesture voting.

## Start

Requires Node.js 18.11 or newer.

    npm install
    npm start

Open http://localhost:8788. Use **Velos Quorum** to open a space or use **Velos Presenter** for the gesture-controlled slide workspace. Quorum rooms require the server; do not open an HTML file directly from File Explorer. If port 8788 is already occupied, stop the older server or choose another port. In Windows Command Prompt, use: `set PORT=8898 && npm start`, then open `http://localhost:8898`. In PowerShell, use: `$env:PORT=8898; npm.cmd start`, then open `http://localhost:8898`.

In Windows PowerShell, use `npm.cmd install` and `npm.cmd start` if the `npm` command is blocked by script execution policy. Keep the terminal open while using Quorum. The join screen retries server detection automatically. If you opened the page through a local preview on another port, the client also checks the Quorum server at `localhost:8788`.

## Public deployment and room invitations

The project includes a Render Blueprint in `render.yaml`. Deploy the Node service in Render as well as deploying the website to Vercel; Vercel alone does not run the persistent Quorum WebSocket server. This project is configured for `https://velos-workspace.onrender.com` (the service shown in your Render dashboard). After Render finishes deploying, open `https://velos-workspace.onrender.com/healthz` and confirm it returns a JSON `status: ok`. Render supplies HTTPS and routes WebSocket connections through the same public service. The app listens on Render's `PORT` and provides `/healthz` for deploy health checks. Quorum pages served by Render automatically connect back to their current Render host; pages served by Vercel connect to `wss://velos-workspace.onrender.com/quorum-space`. A free Render service can take 50 seconds or more to wake after inactivity; the join screen reports the active endpoint if it cannot connect.

After deployment, open the public `/quorum/` page, create a room, and use **Invite** in the room header. The copied URL opens the same deployment with that room code prefilled; each guest enters a name and selects **Join with code**. Guests need browser access to camera/microphone if they want to use video. In **Tools**, open a platform tile in its own tab, return to Quorum, and choose **Share with Quorum**. Pick that tab to present it. Full-display sharing works for presenting; host-approved ShareView remote control is available only when the Node server runs on the Windows computer being controlled, so it is not available from a Render-hosted service.

The included Blueprint uses Render's free plan to keep initial hosting cost-free. Free services can sleep after inactivity, and this app keeps active room state in memory, so a restart or sleep cycle ends current rooms. For scheduled sessions, select an always-on plan and keep the service at one instance: room state is local to the running server, so horizontal scaling is not configured. The app currently has no accounts or private-room password; anyone with an invite link can attempt to join. Peer-to-peer video may need a TURN relay on restrictive networks.

### Vercel deployment

Deploy this project folder to Vercel for the website, then deploy the Node service to Render for Quorum WebSockets and room state. Keep the Render service at one instance because active room state is held in that server process. Vercel serves the pages and static files; the Quorum browser client connects to `velos-workspace.onrender.com`. Invite links can use the Vercel website URL, while Render handles signaling and shared participant state. ShareView remote control remains Windows-host-only.

## Quorum

- The first participant is the host. Participants appear in movable boxes; the host can arrange them into up to eight groups.
- The host can set a motion and open a timed or untimed ballot. Participants can vote with buttons or hand gestures.
- Participants may enter an optional self-reported position, rank, skillsets, and department before joining. The host sees those details with the white **+** button on a participant box; other members receive no profile fields from the server.
- On phones with front and rear cameras, use **Flip** in the call dock to switch lenses. Browsers with only one camera report that no alternate lens is available.
- Present the built-in Quorum slides or share a screen from the presentation controls.
- The shared stage offers **Fit** to show the whole screen, **Fill** to use the available stage area, and **Full screen** to expand the presentation view. Fill can crop the shared display's edges.
- The **Tools** menu is a one-click launcher for Google Docs, Sheets, Slides, Drive, Google Maps, OpenStreetMap, Trello, Notion, GitHub, Miro, Excalidraw, Canva, Padlet, and Mermaid Live. Each tile opens that platform in a new tab; free-plan limits and sign-in requirements vary by provider.
- ShareView-inspired remote control is available only when this Node server runs on the Windows computer being shared. The host shares the full display, and must explicitly approve one participant's request. The host can revoke control at any time; control ends when sharing stops or the participant leaves.
- Remote control sends mouse and keyboard input to the Windows computer running the server. Only share with people you trust. Screen sharing requires browser permission each time. Choose the primary display to keep the shared picture aligned with the computer's cursor.

## Requirements and limits

- Camera, microphone, and screen capture need a secure browser context (localhost or HTTPS) and individual browser permission.
- Gesture detection loads MediaPipe from a CDN, so gesture features need internet access. It tries GPU tracking first and falls back to CPU tracking when GPU support is unavailable. Manual voting and mouse dragging do not need hand tracking.
- Media uses peer-to-peer WebRTC. Some networks need a TURN relay; configure one before relying on restrictive networks.
- Room state lives in server memory and resets when the server restarts or the room empties. There are no accounts or persistent room storage.
- The local server accepts up to 16 participants and eight groups per room. Set PORT to choose another listen port.

## Project structure

- index.html and velos-face-login.js: Velos landing page.
- app/: the active Velos presenter page, styles, and hand-tracking integration.
- quorum/: the Quorum page, styles, and meeting client.
- server.js: static hosting, room state, WebSocket signaling, and host-authorized remote-control input.
- remote-input.js: Windows-only local input bridge, started only after the host approves a control request.
