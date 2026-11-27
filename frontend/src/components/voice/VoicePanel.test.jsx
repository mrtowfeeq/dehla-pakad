import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { VoicePanel } from "@/components/voice/VoicePanel";

jest.mock("@/context/AppContext", () => ({
  useApp: () => global.__voiceContext,
  useSocketEvent: (handler) => { global.__voiceEventHandler = handler; },
}));

class MockPeerConnection {
  constructor() {
    MockPeerConnection.instances.push(this);
    this.signalingState = "stable";
    this.connectionState = "new";
    this.transceiver = { sender: { replaceTrack: jest.fn(() => Promise.resolve()) } };
  }
  addTransceiver = jest.fn(() => this.transceiver);
  createOffer = jest.fn(async () => ({ type: "offer", sdp: "local-offer" }));
  setLocalDescription = jest.fn(async (description) => {
    this.localDescription = description;
    this.signalingState = "have-local-offer";
  });
  close = jest.fn();
}
MockPeerConnection.instances = [];

global.IS_REACT_ACT_ENVIRONMENT = true;

describe("VoicePanel user controls", () => {
  let container;
  let root;
  let send;
  let getUserMedia;
  let originalPeerConnection;
  let originalMediaDevices;
  let originalAudioPlay;

  const click = async (element) => act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });

  const render = () => act(() => root.render(<VoicePanel gameId="game-1" />));
  const byId = (id) => container.querySelector(`[data-testid="${id}"]`);

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    send = jest.fn(() => true);
    getUserMedia = jest.fn();
    global.__voiceContext = { me: { username: "player1", display_name: "Player One" }, send, connected: true };
    global.__voiceEventHandler = null;
    originalPeerConnection = global.RTCPeerConnection;
    originalMediaDevices = navigator.mediaDevices;
    originalAudioPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = jest.fn().mockResolvedValue(undefined);
    MockPeerConnection.instances = [];
    global.RTCPeerConnection = MockPeerConnection;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  });

  afterEach(() => {
    if (root) act(() => root.unmount());
    container?.remove();
    global.RTCPeerConnection = originalPeerConnection;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: originalMediaDevices });
    HTMLMediaElement.prototype.play = originalAudioPlay;
    delete global.__voiceContext;
    delete global.__voiceEventHandler;
    jest.clearAllTimers();
  });

  test("does not request microphone until Join Voice is explicitly activated", async () => {
    getUserMedia.mockRejectedValue({ name: "NotAllowedError" });
    render();
    expect(getUserMedia).not.toHaveBeenCalled();
    await click(byId("voice-panel-toggle"));
    expect(byId("voice-join")).toBeTruthy();
    await click(byId("voice-join"));
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(send).toHaveBeenCalledWith({ type: "voice_join", game_id: "game-1", request_id: expect.any(String) });

    act(() => global.__voiceEventHandler({ type: "voice_joined", session_id: "session-1",
      self_peer_id: "peer-a", participants: [], ice_servers: [] }));
    expect(byId("voice-status").textContent).toContain("Connected");
    expect(byId("voice-message").textContent).toMatch(/permission was denied/i);
    expect(byId("voice-message").textContent).toMatch(/still listen/i);
    expect(byId("voice-microphone-toggle").getAttribute("aria-label")).toBe("Enable microphone");

    await click(byId("voice-speaker-toggle"));
    expect(byId("voice-speaker-toggle").getAttribute("aria-label")).toBe("Enable voice speakers");
    await click(byId("voice-leave"));
    expect(send).toHaveBeenCalledWith({ type: "voice_leave", session_id: "session-1" });
    expect(byId("voice-status").textContent).toContain("Not joined");
  });

  test("stops the microphone on WebSocket loss and never rejoins without another user action", async () => {
    const track = { enabled: true, stop: jest.fn() };
    const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
    getUserMedia.mockResolvedValue(stream);
    render();
    await click(byId("voice-panel-toggle"));
    await click(byId("voice-join"));
    act(() => global.__voiceEventHandler({ type: "voice_joined", session_id: "session-a",
      self_peer_id: "peer-a", participants: [], ice_servers: [] }));
    expect(track.enabled).toBe(true);

    global.__voiceContext = { ...global.__voiceContext, connected: false };
    render();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(byId("voice-status").textContent).toMatch(/Reconnecting/i);
    global.__voiceContext = { ...global.__voiceContext, connected: true };
    render();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(send.mock.calls.filter(([message]) => message.type === "voice_join")).toHaveLength(1);
    expect(byId("voice-rejoin")).toBeTruthy();

    await click(byId("voice-rejoin"));
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.filter(([message]) => message.type === "voice_join")).toHaveLength(2);
  });

  test("component cleanup leaves the signaling session and stops all local audio tracks", async () => {
    const track = { enabled: true, stop: jest.fn() };
    const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
    getUserMedia.mockResolvedValue(stream);
    render();
    await click(byId("voice-panel-toggle"));
    await click(byId("voice-join"));
    act(() => global.__voiceEventHandler({ type: "voice_joined", session_id: "session-cleanup",
      self_peer_id: "peer-a", participants: [], ice_servers: [] }));

    act(() => root.unmount());
    expect(track.stop).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({ type: "voice_leave", session_id: "session-cleanup" });
    root = null;
  });

  test("attaches only the remote audio track to a live, audible DOM audio element", async () => {
    getUserMedia.mockRejectedValue({ name: "NotAllowedError" });
    render();
    await click(byId("voice-panel-toggle"));
    await click(byId("voice-join"));
    act(() => global.__voiceEventHandler({ type: "voice_joined", session_id: "session-audio",
      self_peer_id: "peer-a", participants: [{ peer_id: "peer-b", display_name: "Remote" }], ice_servers: [] }));
    const pc = MockPeerConnection.instances[0];
    expect(pc).toBeTruthy();

    const remoteTrack = { id: "remote-track", kind: "audio", readyState: "live", enabled: true, muted: false,
      addEventListener: jest.fn(), removeEventListener: jest.fn() };
    const remoteStream = { getAudioTracks: () => [remoteTrack] };
    act(() => pc.ontrack({ track: remoteTrack, streams: [remoteStream] }));

    const audio = byId("voice-audio-peer-b");
    expect(audio).toBeTruthy();
    expect(audio.isConnected).toBe(true);
    expect(audio.srcObject).toBe(remoteStream);
    expect(audio.muted).toBe(false);
    expect(audio.volume).toBe(1);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    expect(container.querySelector('[data-testid="voice-audio-peer-a"]')).toBeNull();
  });

  test("surfaces an autoplay rejection instead of treating a remote track as heard", async () => {
    getUserMedia.mockRejectedValue({ name: "NotAllowedError" });
    HTMLMediaElement.prototype.play = jest.fn().mockRejectedValue(new DOMException("Blocked", "NotAllowedError"));
    render();
    await click(byId("voice-panel-toggle"));
    await click(byId("voice-join"));
    act(() => global.__voiceEventHandler({ type: "voice_joined", session_id: "session-blocked",
      self_peer_id: "peer-a", participants: [{ peer_id: "peer-b", display_name: "Remote" }], ice_servers: [] }));
    const track = { id: "blocked-track", kind: "audio", readyState: "live", enabled: true, muted: false,
      addEventListener: jest.fn(), removeEventListener: jest.fn() };
    act(() => MockPeerConnection.instances[0].ontrack({ track, streams: [{ getAudioTracks: () => [track] }] }));
    await act(async () => { await Promise.resolve(); });
    expect(byId("voice-playback-blocked")).toBeTruthy();
    expect(byId("voice-status").textContent).toContain("Connected");
  });

  describe("leave and rejoin", () => {
    const joinRequests = () => send.mock.calls.map(([message]) => message).filter((message) => message.type === "voice_join");
    const emit = (event) => act(() => global.__voiceEventHandler(event));
    const makeStream = () => {
      const track = { kind: "audio", readyState: "live", enabled: true, muted: false, stop: jest.fn() };
      return { track, stream: { getAudioTracks: () => [track], getTracks: () => [track] } };
    };
    const openPeerConnections = () => MockPeerConnection.instances.filter((pc) => pc.close.mock.calls.length === 0);

    test("initial join, leave, and immediate rejoin ignore the late leave reply and replace peer connections", async () => {
      const first = makeStream();
      const second = makeStream();
      getUserMedia.mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
      render();
      await click(byId("voice-panel-toggle"));
      await click(byId("voice-join"));
      const [join1] = joinRequests();
      emit({ type: "voice_joined", request_id: join1.request_id, session_id: "room-session",
        self_peer_id: "peer-a", participants: [{ peer_id: "peer-b", display_name: "Remote" }], ice_servers: [] });
      expect(byId("voice-status").textContent).toContain("Connected");
      const firstPc = MockPeerConnection.instances[0];
      expect(firstPc.addTransceiver).toHaveBeenCalledTimes(1);

      await click(byId("voice-leave"));
      expect(send).toHaveBeenCalledWith({ type: "voice_leave", session_id: "room-session" });
      expect(first.track.stop).toHaveBeenCalled();
      expect(firstPc.close).toHaveBeenCalledTimes(1);

      await click(byId("voice-join"));
      const [, join2] = joinRequests();
      expect(join2.request_id).toBeTruthy();
      expect(join2.request_id).not.toBe(join1.request_id);

      // The server's reply to the earlier leave arrives after the new join started.
      emit({ type: "voice_left", session_id: "room-session", peer_id: "peer-a" });
      expect(byId("voice-cancel")).toBeTruthy();
      expect(second.track.stop).not.toHaveBeenCalled();

      emit({ type: "voice_joined", request_id: join2.request_id, session_id: "room-session",
        self_peer_id: "peer-c", participants: [{ peer_id: "peer-d", display_name: "Remote" }], ice_servers: [] });
      expect(byId("voice-status").textContent).toContain("Connected");
      expect(byId("voice-message")).toBeNull();
      expect(openPeerConnections()).toHaveLength(1);
      expect(openPeerConnections()[0].addTransceiver).toHaveBeenCalledTimes(1);
      expect(getUserMedia).toHaveBeenCalledTimes(2);
    });

    test("multiple rapid Join Voice clicks send a single join request", async () => {
      let resolveMedia;
      getUserMedia.mockImplementation(() => new Promise((resolve) => { resolveMedia = resolve; }));
      render();
      await click(byId("voice-panel-toggle"));
      const joinButton = byId("voice-join");
      await act(async () => { joinButton.click(); joinButton.click(); joinButton.click(); });
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      await act(async () => { resolveMedia(makeStream().stream); await Promise.resolve(); });
      expect(joinRequests()).toHaveLength(1);
    });

    test("leave while a join is pending ignores the cancelled attempt's replies and the rejoin succeeds", async () => {
      const cancelled = makeStream();
      getUserMedia.mockResolvedValueOnce(cancelled.stream).mockResolvedValueOnce(makeStream().stream);
      render();
      await click(byId("voice-panel-toggle"));
      await click(byId("voice-join"));
      const [join1] = joinRequests();
      await click(byId("voice-cancel"));
      expect(send).toHaveBeenCalledWith({ type: "voice_leave" });
      expect(cancelled.track.stop).toHaveBeenCalled();

      await click(byId("voice-join"));
      const [, join2] = joinRequests();
      // Replies to the cancelled attempt arrive late, in server order.
      emit({ type: "voice_joined", request_id: join1.request_id, session_id: "s", self_peer_id: "peer-old",
        participants: [{ peer_id: "peer-z" }], ice_servers: [] });
      emit({ type: "voice_left", session_id: "s", peer_id: "peer-old" });
      emit({ type: "voice_error", request_id: join1.request_id, message: "Too many voice join attempts" });
      emit({ type: "voice_error", signal_id: "old-signal", message: "Voice recipient is not connected" });
      expect(byId("voice-cancel")).toBeTruthy();
      expect(MockPeerConnection.instances).toHaveLength(0);

      emit({ type: "voice_joined", request_id: join2.request_id, session_id: "s", self_peer_id: "peer-new",
        participants: [{ peer_id: "peer-z" }], ice_servers: [] });
      expect(byId("voice-status").textContent).toContain("Connected");
      expect(openPeerConnections()).toHaveLength(1);
    });

    test("an error for the pending join request still fails it", async () => {
      getUserMedia.mockResolvedValue(makeStream().stream);
      render();
      await click(byId("voice-panel-toggle"));
      await click(byId("voice-join"));
      const [join1] = joinRequests();
      emit({ type: "voice_error", request_id: join1.request_id, message: "Too many voice join attempts" });
      expect(byId("voice-status").textContent).toContain("Connection failed");
      expect(byId("voice-message").textContent).toContain("Too many voice join attempts");
      await click(byId("voice-join"));
      expect(joinRequests()).toHaveLength(2);
    });

    test("rejoin after a WebSocket reconnect creates a fresh membership without stale peer connections", async () => {
      getUserMedia.mockResolvedValue(makeStream().stream);
      render();
      await click(byId("voice-panel-toggle"));
      await click(byId("voice-join"));
      emit({ type: "voice_joined", request_id: joinRequests()[0].request_id, session_id: "s1",
        self_peer_id: "peer-a", participants: [{ peer_id: "peer-b" }], ice_servers: [] });
      const oldPc = MockPeerConnection.instances[0];
      global.__voiceContext = { ...global.__voiceContext, connected: false };
      render();
      expect(oldPc.close).toHaveBeenCalledTimes(1);
      global.__voiceContext = { ...global.__voiceContext, connected: true };
      render();
      await click(byId("voice-rejoin"));
      const rejoin = joinRequests()[1];
      emit({ type: "voice_joined", request_id: rejoin.request_id, session_id: "s1",
        self_peer_id: "peer-c", participants: [{ peer_id: "peer-b" }], ice_servers: [] });
      expect(byId("voice-status").textContent).toContain("Connected");
      expect(openPeerConnections()).toHaveLength(1);
      expect(openPeerConnections()[0]).not.toBe(oldPc);
    });

    test("a remote participant leaving and rejoining replaces its peer connection", async () => {
      getUserMedia.mockResolvedValue(makeStream().stream);
      render();
      await click(byId("voice-panel-toggle"));
      await click(byId("voice-join"));
      emit({ type: "voice_joined", request_id: joinRequests()[0].request_id, session_id: "s1",
        self_peer_id: "peer-a", participants: [{ peer_id: "peer-b", display_name: "Remote" }], ice_servers: [] });
      const oldPc = MockPeerConnection.instances[0];
      emit({ type: "voice_peer_left", session_id: "s1", peer_id: "peer-b" });
      emit({ type: "voice_peer_joined", session_id: "s1", participant: { peer_id: "peer-d", display_name: "Remote" } });
      emit({ type: "voice_presence", session_id: "s1", participants: [
        { peer_id: "peer-a", display_name: "Player One" }, { peer_id: "peer-d", display_name: "Remote" }] });
      expect(oldPc.close).toHaveBeenCalledTimes(1);
      expect(openPeerConnections()).toHaveLength(1);
      expect(openPeerConnections()[0].addTransceiver).toHaveBeenCalledTimes(1);
      expect(byId("voice-participant-count").textContent).toBe("2");
    });
  });
});
