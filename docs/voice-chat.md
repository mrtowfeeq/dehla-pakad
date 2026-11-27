# Real-time voice chat

## Architecture and privacy

Voice uses browser-native WebRTC audio with a bounded, full-mesh peer connection for each participant pair. The existing authenticated `/api/ws` connection carries only membership, presence, SDP offer/answer, and ICE signaling. Microphone audio travels directly between browsers; this application does not record it, store it, or send it through FastAPI or MongoDB.

The current repository has no SFU or media relay service. The default channel limit is six participants (four seated players plus two spectators). `VOICE_MAX_PARTICIPANTS` may lower or raise this limit, but the backend clamps it to 2–8. At eight participants, a browser maintains up to seven peer connections and uploads its audio to seven peers. This is intended for small game rooms only; it is not an unlimited group-call design.

Players must be seated in the room or active game. A spectator must first pass the existing spectator join checks on the same authenticated WebSocket. Private spectator invitations and administrator spectator permissions continue to be checked by the existing backend rules. Voice presence is ephemeral, environment-scoped, and contains only display name, avatar presentation, player/spectator role, mute state, and speaking state. Closing/finishing a game, deleting/closing a room, leaving, suspension, WebSocket disconnect, or spectator-access revocation removes voice membership.

## Signaling protocol

The frontend sends these events on its already-authenticated WebSocket:

- `voice_join` with exactly one of `room_code` (lobby) or `game_id` (active match).
- `voice_leave` with the current `session_id` when one has been assigned.
- `voice_offer` / `voice_answer` with `session_id`, `to_peer_id`, `connection_id`, and a bounded audio-only SDP `description`.
- `voice_ice_candidate` with `session_id`, `to_peer_id`, `connection_id`, and one bounded ICE `candidate`.
- `voice_mute_changed` and `voice_speaking_changed` with `session_id` and a boolean state.

The server assigns peer and session IDs and derives the sender from the authenticated socket. Offers are allowed only from the lexicographically lower peer ID; answers travel back to that peer. The server verifies that both peers remain authorized members of the same current session and that the pair connection ID matches before forwarding. It returns `voice_joined`, `voice_peer_joined`, `voice_peer_left`, `voice_presence`, `voice_left`, or a generic `voice_error` response. Session IDs reject stale messages after a reconnect. SDP and ICE are forwarded transiently and are not written to application logs or storage. Join and signaling messages use per-user rate limits; voice membership is additionally capped per room.

## Configuration

Configure these values in the backend's local/deployment environment. No production settings are changed by this implementation.

| Variable | Purpose |
| --- | --- |
| `VOICE_MAX_PARTICIPANTS` | Optional total participant cap; defaults to `6`, backend hard maximum `8`. |
| `VOICE_STUN_URLS` | Optional comma-separated STUN URLs. Defaults to `stun:stun.l.google.com:19302`. |
| `VOICE_TURN_URLS` | Optional comma-separated TURN/TURNS URLs. |
| `VOICE_TURN_SHARED_SECRET` | Server-only coturn REST shared secret. Never put this in frontend configuration or source control. |
| `VOICE_TURN_CREDENTIAL_TTL_SECONDS` | Temporary TURN credential lifetime; defaults to `600`, clamped to 60–3600 seconds. |

When TURN URLs and the backend shared secret are both configured, the backend creates a short-lived coturn REST username and HMAC-SHA1 credential and returns it only to that authenticated voice participant. Static credentials embedded in ICE URLs are rejected. If either value is missing, TURN is omitted. The secret itself is never sent to the browser. Do not expose the coturn shared secret in `REACT_APP_*` variables.

STUN-only connectivity is not universal. Symmetric NATs, carrier networks, enterprise firewalls, and restrictive mobile networks may require TURN. Deployments that need reliable cross-network/mobile connectivity must provision and test an authorized TURN service, configure its URLs and server-only secret, and open the TURN service's configured UDP/TCP/TLS ports. No TURN service or credentials are bundled here.

## Browser requirements

Joining is always an explicit action. The browser requests audio-only microphone access after the user presses Join Voice; it never requests camera access. If permission is denied or a microphone is unavailable, the user still joins as a listener. Muting disables the microphone media track; speaker mute applies only to local remote-audio playback. A WebSocket reconnect stops local tracks and closes peer connections; the user must press Rejoin Voice again, and the microphone is requested again only from that action.

Microphone capture generally requires a secure context (HTTPS); `localhost` is permitted for local development. Supported browser versions must provide `RTCPeerConnection`; microphone controls additionally require `getUserMedia`. Speaking indication uses Web Audio energy analysis when available, sends only state transitions, and is omitted when Web Audio is unavailable.

## Desktop Chrome diagnostics

In a development build, open DevTools in each player tab and filter the Console for `[Dehla Pakad voice]`. The logs distinguish local microphone capture and presence from peer transport. They record SDP event/type and signaling state, per-peer connection/ICE/gathering states, local and remote candidate counts by host/srflx/relay/prflx type, candidate errors, buffered/applied candidate counts, remote audio track events, and audio playback outcomes. No SDP body, raw ICE candidate, IP address, Clerk token, TURN username, or TURN credential is logged.

To collect a current snapshot from each tab, run:

```js
await window.__dehlaPakadVoiceDiagnostics?.()
```

The snapshot includes sanitized ICE server endpoints, whether temporary credentials are present, their expiry time (when encoded in the coturn username), selected candidate-pair types/protocol/state, sent/received bytes, and inbound/outbound audio RTP counters and energy where the browser exposes them. It is only installed in development mode. The local `Speaking` indicator is computed from the local microphone analyser and is not proof of transmission; compare outbound audio counters from the speaker's tab with inbound audio counters and `audioLevel`/`totalAudioEnergy` in the listener's tab.

For two-way desktop verification, open the same local game as two authenticated Chrome sessions, join voice in both, and wait for `iceConnectionState` to reach `connected` or `completed`. Capture the diagnostic snapshot in both tabs, speak from one side, and compare outbound audio counters in that tab with inbound counters in the other; then reverse direction. Repeat after mute/unmute, leave/rejoin, and refresh. `candidate_pairs` identifies the selected host, srflx, or relay pair without exposing candidate addresses. A connection that remains `checking`/`connecting`, has no selected pair, or has zero inbound RTP while the other tab's outbound RTP rises is not a successful audio path.

The backend defaults to `stun:stun.l.google.com:19302`; `VOICE_TURN_URLS` defaults to empty. This source configuration does not establish what ICE variables are present in a running local process. Confirm the snapshot in both tabs before deciding whether STUN is enough or a TURN service is required. Static credentials embedded in ICE URLs are intentionally rejected; configure TURN URLs and the server-only shared secret to receive temporary credentials. No TURN connectivity is claimed without an actual selected relay pair.

## Local development

Run the existing frontend and backend with their normal development commands. On `localhost`, users can join an eligible lobby or active game, explicitly join voice, and test with another authenticated seated player or authorized spectator. For device-to-device connectivity across separate networks, configure a development TURN service as described above. Do not use production credentials or databases for local validation.

## Scaling and future SFU migration

Mesh signaling and presence are isolated in `backend/voice.py`; browser peer lifecycle is isolated in `frontend/src/services/voiceService.js` and `frontend/src/hooks/useVoiceChat.js`. A future SFU can replace the peer manager and signaling payloads while leaving the game table and `VoicePanel` control surface largely intact. Before increasing the participant cap or moving to multiple backend workers, introduce an SFU and shared presence/signaling coordination deliberately; current voice rooms and rate limits are in-process and support the application's existing single-process deployment model only.

## Manual verification checklist

Automated tests mock media and WebRTC. Before release, manually verify on desktop Chrome, Android Chrome, and iOS Safari where available:

1. Join from two players, then from a player and authorized spectator; confirm all share one channel.
2. Deny microphone access and confirm the user can hear other participants.
3. Mute/unmute the microphone and independently mute/unmute speakers.
4. Confirm speaking and muted indicators update, and that closing the voice panel does not stop audio.
5. Leave voice, refresh/reconnect, and confirm no microphone starts until Join/Rejoin is pressed again.
6. Revoke private spectator access, close/cancel/finish the game, and confirm the corresponding voice participants are removed.
7. Test peers on different Wi-Fi/mobile networks with the actual configured STUN/TURN infrastructure. STUN-only local testing does not verify TURN or restrictive-network behavior.
