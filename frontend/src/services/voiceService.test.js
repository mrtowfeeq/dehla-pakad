import { VoicePeerManager, voiceConnectionId, voicePermissionMessage } from "@/services/voiceService";

class MockPeerConnection {
  constructor(configuration) {
    this.configuration = configuration;
    this.signalingState = "stable";
    this.connectionState = "new";
    this.iceConnectionState = "new";
    this.iceGatheringState = "new";
    // Mirrors JSEP: a remote offer's m-line is never associated with a transceiver created by
    // addTransceiver(); setRemoteDescription(offer) creates a new recvonly transceiver instead.
    this.transceivers = [];
    const makeTransceiver = (direction, mid = null) => {
      const transceiver = { mid, direction, stopped: false, receiver: { track: { kind: "audio" } },
        sender: { track: null, replaceTrack: jest.fn(async (track) => { transceiver.sender.track = track; }) } };
      this.transceivers.push(transceiver);
      return transceiver;
    };
    this.addTransceiver = jest.fn((kind, init) => makeTransceiver(init?.direction || "sendrecv"));
    this.getTransceivers = jest.fn(() => [...this.transceivers]);
    this.createOffer = jest.fn(async () => ({ type: "offer", sdp: "offer-sdp" }));
    this.answerDirections = [];
    this.createAnswer = jest.fn(async () => {
      const associated = this.transceivers.find((transceiver) => transceiver.mid != null);
      this.answerDirections.push(associated?.direction || "inactive");
      return { type: "answer", sdp: `answer-sdp a=${associated?.direction || "inactive"}` };
    });
    this.setLocalDescription = jest.fn(async (description) => {
      this.localDescription = description;
      if (description.type === "offer") this.transceivers.forEach((transceiver, index) => { transceiver.mid ??= String(index); });
      this.signalingState = description.type === "offer" ? "have-local-offer" : "stable";
    });
    this.setRemoteDescription = jest.fn(async (description) => {
      this.remoteDescription = description;
      if (description.type === "offer" && !this.transceivers.some((transceiver) => transceiver.mid != null)) {
        makeTransceiver("recvonly", "0");
      }
      this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
    });
    this.addIceCandidate = jest.fn(async () => {});
    this.getSenders = jest.fn(() => this.transceivers.map((transceiver) => transceiver.sender));
    this.getStats = jest.fn(async () => new Map());
    this.restartIce = jest.fn();
    this.close = jest.fn(() => { this.connectionState = "closed"; });
  }
}

describe("VoicePeerManager", () => {
  test("uses audio-only transceivers and one deterministic offer per peer pair", async () => {
    const send = jest.fn(() => true);
    const manager = new VoicePeerManager({ send, PeerConnection: MockPeerConnection });
    manager.start({ sessionId: "session", selfPeerId: "a", participants: [{ peer_id: "b" }],
      iceServers: [{ urls: ["stun:voice.test"] }] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.peers.size).toBe(1);
    const peer = manager.peers.get("b");
    expect(peer.pc.configuration.iceServers[0].urls).toEqual(["stun:voice.test"]);
    expect(peer.pc.addTransceiver).toHaveBeenCalledWith("audio", { direction: "sendrecv" });
    expect(peer.pc.createOffer).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "voice_offer", session_id: "session", to_peer_id: "b",
      connection_id: voiceConnectionId("a", "b"),
    }));

    manager.close();
    expect(peer.pc.close).toHaveBeenCalledTimes(1);
    expect(manager.peers.size).toBe(0);
  });

  test("attaches the live microphone track before creating the peer offer", async () => {
    const send = jest.fn(() => true);
    const track = { kind: "audio", readyState: "live", enabled: true, muted: false };
    const manager = new VoicePeerManager({ send, PeerConnection: MockPeerConnection, channelId: "game-1" });
    manager.start({ sessionId: "session-audio", selfPeerId: "a", participants: [{ peer_id: "b" }],
      stream: { getAudioTracks: () => [track] } });
    const peer = manager.peers.get("b");
    expect(peer.pc.createOffer).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(peer.pc.getSenders()).toContain(peer.transceiver.sender);
    expect(peer.pc.getSenders()[0].track).toBe(track);
    expect(peer.pc.getSenders()[0].track.enabled).toBe(true);
    expect(peer.pc.createOffer).toHaveBeenCalledTimes(1);
    manager.close();
  });

  test("answerer sends its microphone on the transceiver negotiated by the remote offer", async () => {
    const send = jest.fn(() => true);
    const track = { kind: "audio", readyState: "live", enabled: true, muted: false };
    const manager = new VoicePeerManager({ send, PeerConnection: MockPeerConnection });
    manager.start({ sessionId: "s-answer", selfPeerId: "z", participants: [{ peer_id: "a" }],
      stream: { getAudioTracks: () => [track] } });
    const peer = manager.peers.get("a");
    expect(peer.pc.addTransceiver).not.toHaveBeenCalled();

    await manager.receive({ type: "voice_offer", session_id: "s-answer", from_peer_id: "a",
      connection_id: voiceConnectionId("a", "z"), description: { type: "offer", sdp: "offer-a" } });

    expect(peer.pc.getSenders()).toHaveLength(1);
    expect(peer.pc.getSenders()[0].track).toBe(track);
    expect(peer.transceiver.mid).toBe("0");
    expect(peer.transceiver.direction).toBe("sendrecv");
    expect(peer.pc.answerDirections).toEqual(["sendrecv"]);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "voice_answer" }));

    // An ICE-restart offer reuses the same transceiver and does not add senders.
    await manager.receive({ type: "voice_offer", session_id: "s-answer", from_peer_id: "a",
      connection_id: voiceConnectionId("a", "z"), description: { type: "offer", sdp: "offer-a-restart" } });
    expect(peer.pc.getSenders()).toHaveLength(1);
    expect(peer.pc.answerDirections).toEqual(["sendrecv", "sendrecv"]);
    manager.close();
  });

  test("listener answerer attaches a microphone enabled after negotiation without renegotiating", async () => {
    const send = jest.fn(() => true);
    const manager = new VoicePeerManager({ send, PeerConnection: MockPeerConnection });
    manager.start({ sessionId: "s-listen", selfPeerId: "z", participants: [{ peer_id: "a" }] });
    const peer = manager.peers.get("a");
    await manager.receive({ type: "voice_offer", session_id: "s-listen", from_peer_id: "a",
      connection_id: voiceConnectionId("a", "z"), description: { type: "offer", sdp: "offer-a" } });
    expect(peer.pc.answerDirections).toEqual(["sendrecv"]);
    expect(peer.pc.getSenders()[0].track).toBeNull();

    const track = { kind: "audio", readyState: "live", enabled: true, muted: false };
    manager.setLocalStream({ getAudioTracks: () => [track] });
    await peer.trackReady;
    expect(peer.pc.getSenders()).toHaveLength(1);
    expect(peer.pc.getSenders()[0].track).toBe(track);
    expect(peer.pc.createOffer).not.toHaveBeenCalled();
    manager.close();
  });

  test("answers only the deterministic peer, deduplicates signals, and ignores stale sessions", async () => {
    const send = jest.fn(() => true);
    const manager = new VoicePeerManager({ send, PeerConnection: MockPeerConnection });
    manager.start({ sessionId: "s2", selfPeerId: "z", participants: [{ peer_id: "a" }] });
    const peer = manager.peers.get("a");
    expect(peer.pc.createOffer).not.toHaveBeenCalled();

    const offer = {
      type: "voice_offer", session_id: "s2", from_peer_id: "a",
      connection_id: voiceConnectionId("a", "z"), description: { type: "offer", sdp: "offer-a" },
    };
    await manager.receive(offer);
    await manager.receive(offer);
    expect(peer.pc.setRemoteDescription).toHaveBeenCalledTimes(1);
    expect(peer.pc.createAnswer).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "voice_answer", session_id: "s2", to_peer_id: "a",
      connection_id: voiceConnectionId("a", "z"),
    }));

    const candidate = { type: "voice_ice_candidate", session_id: "s2", from_peer_id: "a",
      connection_id: voiceConnectionId("a", "z"), candidate: { candidate: "candidate:1" } };
    await manager.receive(candidate);
    await manager.receive(candidate);
    expect(peer.pc.addIceCandidate).toHaveBeenCalledTimes(1);
    await manager.receive({ ...candidate, session_id: "old-session", candidate: { candidate: "candidate:old" } });
    expect(peer.pc.addIceCandidate).toHaveBeenCalledTimes(1);

    manager.close();
  });

  test("correlates outgoing signaling errors and records stale message rejection reasons", async () => {
    const send = jest.fn(() => true);
    const log = jest.spyOn(console, "info").mockImplementation(() => {});
    const manager = new VoicePeerManager({ send, PeerConnection: MockPeerConnection,
      channelId: "game-trace", diagnosticsEnabled: true });
    manager.start({ sessionId: "session-trace", selfPeerId: "a", participants: [{ peer_id: "b" }] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const offer = send.mock.calls.map(([message]) => message).find((message) => message.type === "voice_offer");
    expect(offer).toMatchObject({ type: "voice_offer", session_id: "session-trace", to_peer_id: "b" });
    expect(offer.signal_id).toEqual(expect.any(String));
    expect(offer.created_at_ms).toEqual(expect.any(Number));
    expect(manager.sentSignals.has(offer.signal_id)).toBe(true);
    const diagnostics = await manager.getDiagnostics();
    expect(diagnostics.recent_signals[0]).toMatchObject({
      signal_id: offer.signal_id, socket_send_succeeded: true, server_outcome: "unknown_without_ack",
    });
    manager.handleSignalError({ type: "voice_error", signal_id: offer.signal_id });
    expect(manager.sentSignals.get(offer.signal_id).server_outcome).toBe("rejected");

    await manager.receive({ type: "voice_offer", session_id: "stale-session", from_peer_id: "b",
      connection_id: voiceConnectionId("a", "b"), signal_id: "stale-incoming",
      created_at_ms: 1780000000000, description: { type: "offer", sdp: "private-sdp" } });
    const diagnosticCalls = JSON.stringify(log.mock.calls);
    expect(diagnosticCalls).toContain("server_rejected");
    expect(diagnosticCalls).toContain("session_id_mismatch");
    expect(diagnosticCalls).toContain("stale-incoming");
    expect(diagnosticCalls).not.toContain("private-sdp");
    manager.close();
    log.mockRestore();
  });

  test("does not answer an offer after its peer connection instance was replaced", async () => {
    const send = jest.fn(() => true);
    const log = jest.spyOn(console, "info").mockImplementation(() => {});
    const manager = new VoicePeerManager({ send, PeerConnection: MockPeerConnection, diagnosticsEnabled: true });
    manager.start({ sessionId: "session-stale-pc", selfPeerId: "z", participants: [{ peer_id: "a" }] });
    const peer = manager.peers.get("a");
    let finishRemoteDescription;
    peer.pc.setRemoteDescription = jest.fn(async (description) => {
      await new Promise((resolve) => { finishRemoteDescription = resolve; });
      peer.pc.remoteDescription = description;
      peer.pc.signalingState = "have-remote-offer";
    });
    const receive = manager.receive({ type: "voice_offer", session_id: "session-stale-pc",
      from_peer_id: "a", connection_id: voiceConnectionId("a", "z"), signal_id: "offer-stale-pc",
      description: { type: "offer", sdp: "offer" } });
    await Promise.resolve();
    manager.removeParticipant("a");
    finishRemoteDescription();
    await receive;
    expect(peer.pc.createAnswer).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voice_answer" }));
    expect(JSON.stringify(log.mock.calls)).toContain("peer_instance_stale");
    manager.close();
    log.mockRestore();
  });

  test("reconciles peer connections from authoritative presence without dropping active participants", () => {
    const manager = new VoicePeerManager({ send: jest.fn(() => true), PeerConnection: MockPeerConnection });
    manager.start({ sessionId: "session-presence", selfPeerId: "z", participants: [{ peer_id: "c11" }] });
    const unexpectedPeer = manager.peers.get("c11");
    manager.syncParticipants([{ peer_id: "c11" }, { peer_id: "chrome" }, { peer_id: "z" }]);
    expect(manager.peers.get("c11")).toBe(unexpectedPeer);
    expect(manager.peers.has("chrome")).toBe(true);
    expect(manager.peers.size).toBe(2);

    manager.syncParticipants([{ peer_id: "chrome" }, { peer_id: "z" }]);
    expect(manager.peers.has("c11")).toBe(false);
    expect(unexpectedPeer.pc.close).toHaveBeenCalledTimes(1);
    expect(manager.peers.has("chrome")).toBe(true);
    expect(manager.peers.size).toBe(1);
    manager.close();
  });

  test("queues ICE until the remote description and cleans remote streams on peer leave", async () => {
    const send = jest.fn(() => true);
    const log = jest.spyOn(console, "info").mockImplementation(() => {});
    const onRemoteStream = jest.fn();
    const manager = new VoicePeerManager({ send, onRemoteStream, PeerConnection: MockPeerConnection,
      diagnosticsEnabled: true });
    manager.start({ sessionId: "s3", selfPeerId: "z", participants: [{ peer_id: "b" }] });
    const peer = manager.peers.get("b");
    const candidate = { type: "voice_ice_candidate", session_id: "s3", from_peer_id: "b",
      connection_id: voiceConnectionId("z", "b"), signal_id: "buffered-candidate-1",
      candidate: { candidate: "candidate:2" } };
    await manager.receive(candidate);
    expect(peer.queuedCandidates).toHaveLength(1);
    await manager.receive({ type: "voice_offer", session_id: "s3", from_peer_id: "b",
      connection_id: voiceConnectionId("z", "b"), signal_id: "offer-buffer-flush-1",
      description: { type: "offer", sdp: "offer-b" } });
    expect(peer.pc.addIceCandidate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).toContain("buffered-candidate-1");
    expect(JSON.stringify(log.mock.calls)).toContain("buffered_candidate.applied");

    const stream = { id: "remote-audio" };
    peer.pc.ontrack({ track: { id: "audio-track", kind: "audio", readyState: "live", muted: false }, streams: [stream] });
    expect(onRemoteStream).toHaveBeenCalledWith("b", stream);
    await manager.receive({ type: "voice_peer_left", session_id: "s3", peer_id: "b" });
    expect(peer.pc.close).toHaveBeenCalledTimes(1);
    expect(onRemoteStream).toHaveBeenLastCalledWith("b", null);
    manager.close();
    log.mockRestore();
  });

  test("keeps applying buffered candidates when one candidate is rejected and exposes safe diagnostics", async () => {
    const send = jest.fn(() => true);
    const log = jest.spyOn(console, "info").mockImplementation(() => {});
    const manager = new VoicePeerManager({ send, PeerConnection: MockPeerConnection,
      channelId: "game-ice", diagnosticsEnabled: true });
    manager.start({ sessionId: "session-ice", selfPeerId: "z", participants: [{ peer_id: "a" }],
      iceServers: [{ urls: ["turn:relay.example:3478?transport=udp"],
        username: "1780000000:temporary-id", credential: "turn-secret-test-value" }] });
    const peer = manager.peers.get("a");
    await Promise.resolve();
    peer.pc.addIceCandidate.mockImplementationOnce(() => Promise.reject(new TypeError("stale candidate")));
    const candidate = (address, type) => ({ candidate: `candidate:1 1 udp 100 ${address} 5000 typ ${type}` });
    await manager.receive({ type: "voice_ice_candidate", session_id: "session-ice", from_peer_id: "a",
      connection_id: voiceConnectionId("a", "z"), candidate: candidate("192.0.2.1", "host") });
    await manager.receive({ type: "voice_ice_candidate", session_id: "session-ice", from_peer_id: "a",
      connection_id: voiceConnectionId("a", "z"), candidate: candidate("198.51.100.1", "srflx") });
    await manager.receive({ type: "voice_offer", session_id: "session-ice", from_peer_id: "a",
      connection_id: voiceConnectionId("a", "z"), description: { type: "offer", sdp: "safe-fake-sdp" } });

    peer.pc.localDescription = { type: "answer", sdp: "v=0\r\na=candidate:1 1 udp 100 192.0.2.1 5000 typ host\r\na=candidate:2 1 udp 90 8f3a2c.local 5001 typ host\r\n" };
    peer.pc.remoteDescription = { type: "offer", sdp: "v=0\r\na=candidate:3 1 udp 80 198.51.100.1 6000 typ srflx\r\n" };
    peer.pc.signalingState = "stable";
    peer.pc.iceConnectionState = "checking";
    peer.pc.iceGatheringState = "complete";
    peer.pc.connectionState = "connecting";
    peer.pc.getStats.mockResolvedValue(new Map([
      ["transport", { id: "transport", type: "transport", selectedCandidatePairId: "pair" }],
      ["pair", { id: "pair", type: "candidate-pair", state: "succeeded", selected: true,
        localCandidateId: "local", remoteCandidateId: "remote", bytesSent: 123, bytesReceived: 456 }],
      ["local", { id: "local", type: "local-candidate", candidateType: "host", protocol: "udp",
        address: "8f3a2c.local" }],
      ["remote", { id: "remote", type: "remote-candidate", candidateType: "srflx", protocol: "udp",
        address: "192.0.2.40" }],
      ["out", { id: "out", type: "outbound-rtp", kind: "audio", bytesSent: 55, packetsSent: 4 }],
      ["in", { id: "in", type: "inbound-rtp", kind: "audio", bytesReceived: 66, packetsReceived: 5,
        audioLevel: 0.2, totalAudioEnergy: 0.8 }],
    ]));
    peer.pc.onicecandidate({ candidate: {
      type: "host", candidate: "candidate:2 1 udp 100 192.0.2.2 5000 typ host",
    } });
    peer.pc.onicecandidate({ candidate: {
      candidate: "", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "generation-one",
    } });
    peer.pc.onicecandidate({ candidate: {
      candidate: "candidate:3 1 udp 100 8f3a2c.local 5001 typ host",
      sdpMid: "0", sdpMLineIndex: 0, toJSON() { return {
        candidate: this.candidate, sdpMid: this.sdpMid, sdpMLineIndex: this.sdpMLineIndex,
        foundation: "platform-extension", relatedAddress: "192.0.2.1",
      }; },
    } });
    peer.pc.onicecandidate({ candidate: { toJSON() { throw new TypeError("candidate serialization failed"); } } });
    peer.pc.onicecandidateerror({ errorCode: 701, url: "stun:stun.voice.test:3478" });
    peer.pc.iceConnectionState = "checking";
    peer.pc.oniceconnectionstatechange();
    const diagnostics = await manager.getDiagnostics();
    const snapshot = diagnostics.peers[0];
    expect(peer.pc.addIceCandidate).toHaveBeenCalledTimes(2);
    expect(snapshot.ice_connection_state).toBe("checking");
    expect(snapshot.local_description_type).toBe("answer");
    expect(snapshot.remote_description_type).toBe("offer");
    expect(snapshot.local_sdp_candidates).toMatchObject({ total: 2, counts: { host: 2 }, mdns: 1 });
    expect(snapshot.remote_sdp_candidates).toMatchObject({ total: 1, counts: { srflx: 1 } });
    expect(snapshot.remote_ice_candidates).toMatchObject({ host: 1, srflx: 1 });
    expect(snapshot.local_ice_candidates.host).toBe(2);
    expect(snapshot.local_ice_candidates.end_of_candidates).toBe(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "voice_ice_candidate", candidate: expect.objectContaining({ candidate: "" }),
    }));
    const serializedMdns = send.mock.calls.map(([message]) => message).find((message) =>
      message.type === "voice_ice_candidate" && message.candidate?.candidate?.includes(".local"));
    expect(serializedMdns.candidate).not.toHaveProperty("foundation");
    expect(serializedMdns.candidate).not.toHaveProperty("relatedAddress");
    expect(JSON.stringify(log.mock.calls)).toContain('"candidate_is_mdns":true');
    expect(JSON.stringify(log.mock.calls)).toContain("candidate_serialization_failed");
    expect(snapshot.candidate_errors[0]).toMatchObject({ code: 701, url: "stun:stun.voice.test:3478" });
    expect(snapshot.remote_candidates_buffered).toBe(0);
    expect(snapshot.remote_candidates_applied).toBe(1);
    expect(snapshot.candidate_pairs[0]).toMatchObject({ local_candidate_type: "host", remote_candidate_type: "srflx" });
    expect(snapshot.local_candidate_stats[0]).toMatchObject({ candidate_type: "host", is_mdns: true });
    expect(snapshot.remote_candidate_stats[0]).toMatchObject({ candidate_type: "srflx", is_mdns: false });
    expect(snapshot.inbound_audio[0].audio_level).toBe(0.2);
    expect(snapshot.ice_servers[0]).toMatchObject({ credentialsPresent: true, urls: ["turn:relay.example:3478"] });
    expect(snapshot.ice_servers[0].credentialExpiresAt).toBeTruthy();
    expect(JSON.stringify(snapshot)).not.toContain("turn-secret-test-value");
    expect(JSON.stringify(log.mock.calls)).not.toContain("safe-fake-sdp");
    expect(JSON.stringify(snapshot)).not.toContain("8f3a2c.local");
    manager.close();
    log.mockRestore();
  });
});

test("permission errors explain that listening remains available", () => {
  expect(voicePermissionMessage({ name: "NotAllowedError" })).toMatch(/still listen/i);
  expect(voicePermissionMessage({ name: "NotFoundError" })).toMatch(/still listen/i);
});
