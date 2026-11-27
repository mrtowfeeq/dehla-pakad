export function voiceConnectionId(a, b) {
  return [a, b].sort().join("|");
}

const DEVELOPMENT_DIAGNOSTICS = process.env.NODE_ENV === "development";
const diagnosticManagers = new Set();
const diagnosticSnapshot = async () => Promise.all([...diagnosticManagers].map((manager) => manager.getDiagnostics()));

function safeSend(send, message) {
  try { return Boolean(send(message)); } catch { return false; }
}

function errorName(error) {
  return typeof error?.name === "string" ? error.name.slice(0, 80) : "Error";
}

function signalId() {
  try { return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`; }
  catch { return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`; }
}

function candidateType(candidate) {
  if (candidate?.candidate === "") return "end_of_candidates";
  if (candidate?.type && ["host", "srflx", "relay", "prflx"].includes(candidate.type)) return candidate.type;
  const match = /\btyp\s+(host|srflx|relay|prflx)\b/i.exec(candidate?.candidate || "");
  return match?.[1]?.toLowerCase() || "unknown";
}

function sdpCandidateSummary(description) {
  const counts = { host: 0, srflx: 0, relay: 0, prflx: 0, unknown: 0 };
  let mdns = 0;
  const sdp = description?.sdp;
  if (typeof sdp !== "string") return { total: 0, counts, mdns: 0 };
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith("a=candidate:")) continue;
    const value = line.slice(2);
    counts[candidateType({ candidate: value })] += 1;
    if (/\.local\b/i.test(value)) mdns += 1;
  }
  return { total: Object.values(counts).reduce((sum, count) => sum + count, 0), counts, mdns };
}

function serializeIceCandidate(candidate) {
  const nativeJson = typeof candidate?.toJSON === "function" ? candidate.toJSON() : candidate;
  if (!nativeJson || typeof nativeJson !== "object") return nativeJson;
  const serialized = {};
  for (const key of ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"]) {
    const value = nativeJson[key] ?? candidate?.[key];
    if (value !== undefined) serialized[key] = value;
  }
  return serialized;
}

function trackSummary(track) {
  if (!track) return null;
  return { kind: track.kind || "unknown", readyState: track.readyState || "unknown",
    enabled: Boolean(track.enabled), muted: Boolean(track.muted) };
}

function iceServerSummary(servers = []) {
  return servers.map((server) => {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    return {
      urls: urls.filter((url) => typeof url === "string").map((url) => {
        const match = /^([a-z]+):(.*)$/i.exec(url);
        if (!match) return "unknown";
        const endpoint = match[2].split(/[?#]/, 1)[0].split("@").pop();
        return `${match[1].toLowerCase()}:${endpoint}`;
      }),
      credentialsPresent: Boolean(server?.username && server?.credential),
      credentialExpiresAt: /^\d{9,12}:/.test(server?.username || "")
        ? new Date(Number(server.username.split(":", 1)[0]) * 1000).toISOString() : null,
    };
  });
}

export function logVoiceDiagnostic(event, details = {}) {
  if (!DEVELOPMENT_DIAGNOSTICS || typeof console === "undefined") return;
  console.info(`[Dehla Pakad voice] ${event}`, details);
}

/** Native WebRTC mesh coordinator. It transports audio directly, never through the app socket. */
export class VoicePeerManager {
  constructor({ send, onRemoteStream = () => {}, onPeerState = () => {}, PeerConnection = globalThis.RTCPeerConnection,
    channelId = null, diagnosticsEnabled = DEVELOPMENT_DIAGNOSTICS }) {
    this.send = send;
    this.onRemoteStream = onRemoteStream;
    this.onPeerState = onPeerState;
    this.PeerConnection = PeerConnection;
    this.channelId = channelId;
    this.diagnosticsEnabled = diagnosticsEnabled;
    this.peers = new Map();
    this.sessionId = null;
    this.selfPeerId = null;
    this.iceServers = [];
    this.localTrack = null;
    this.closed = false;
    this.sentSignals = new Map();
  }

  start({ sessionId, selfPeerId, participants = [], iceServers = [], stream = null }) {
    this.sessionId = sessionId;
    this.selfPeerId = selfPeerId;
    this.iceServers = Array.isArray(iceServers) ? iceServers : [];
    this.closed = false;
    this.setLocalStream(stream);
    if (this.diagnosticsEnabled && typeof globalThis.window !== "undefined") {
      diagnosticManagers.add(this);
      globalThis.window.__dehlaPakadVoiceDiagnostics = diagnosticSnapshot;
    }
    this._log("session.started", { ice_servers: iceServerSummary(this.iceServers) });
    participants.forEach((participant) => this.addParticipant(participant));
  }

  setLocalStream(stream) {
    this.localTrack = stream?.getAudioTracks?.()[0] || null;
    this._log("microphone.track.selected", { track: trackSummary(this.localTrack) });
    for (const peer of this.peers.values()) peer.trackReady = this._replaceLocalTrack(peer, this.localTrack);
  }

  _log(event, details = {}) {
    if (!this.diagnosticsEnabled || typeof console === "undefined") return;
    console.info(`[Dehla Pakad voice] ${event}`, {
      channel_id: this.channelId,
      session_id: this.sessionId,
      local_peer_id: this.selfPeerId,
      ...details,
    });
  }

  _peerState(peer) {
    const pc = peer.pc;
    let effectiveIceServers = this.iceServers;
    let iceServerSource = "peer_connection_constructor";
    try {
      const configuration = pc.getConfiguration?.();
      if (configuration && Array.isArray(configuration.iceServers)) {
        effectiveIceServers = configuration.iceServers;
        iceServerSource = "RTCPeerConnection.getConfiguration";
      }
    } catch {
      iceServerSource = "configuration_unavailable";
    }
    return {
      channel_id: this.channelId,
      session_id: this.sessionId,
      local_peer_id: this.selfPeerId,
      remote_peer_id: peer.peerId,
      pc_instance_id: peer.pcInstanceId,
      connection_state: pc.connectionState || "unknown",
      ice_connection_state: pc.iceConnectionState || "unknown",
      ice_gathering_state: pc.iceGatheringState || "unknown",
      signaling_state: pc.signalingState || "unknown",
      local_description_type: pc.localDescription?.type || null,
      remote_description_type: pc.remoteDescription?.type || null,
      local_sdp_candidates: sdpCandidateSummary(pc.localDescription),
      remote_sdp_candidates: sdpCandidateSummary(pc.remoteDescription),
      local_ice_candidates: { ...peer.localCandidateCounts },
      remote_ice_candidates: { ...peer.remoteCandidateCounts },
      remote_candidates_buffered: peer.queuedCandidates.length,
      remote_candidates_applied: peer.remoteCandidatesApplied,
      candidate_errors: [...peer.candidateErrors],
      local_audio_track: trackSummary(this.localTrack),
      senders: (pc.getSenders?.() || []).map((sender) => trackSummary(sender.track)),
      remote_audio_tracks: [...peer.remoteTracks.values()],
      ice_servers: iceServerSummary(effectiveIceServers),
      ice_server_source: iceServerSource,
    };
  }

  async _peerStats(peer) {
    try {
      const report = await peer.pc.getStats();
      const stats = [...report.values()];
      const statsById = new Map(stats.map((stat) => [stat.id, stat]));
      const selectedIds = new Set(stats.filter((stat) => stat.type === "transport" && stat.selectedCandidatePairId)
        .map((stat) => stat.selectedCandidatePairId));
      const candidatePairs = stats.filter((stat) => stat.type === "candidate-pair")
        .slice(0, 24).map((pair) => {
          const local = statsById.get(pair.localCandidateId);
          const remote = statsById.get(pair.remoteCandidateId);
          return {
            state: pair.state || "unknown", selected: Boolean(pair.selected || selectedIds.has(pair.id)),
            nominated: Boolean(pair.nominated), local_candidate_type: local?.candidateType || "unknown",
            remote_candidate_type: remote?.candidateType || "unknown", protocol: pair.protocol || local?.protocol || null,
            bytes_sent: pair.bytesSent || 0, bytes_received: pair.bytesReceived || 0,
            current_round_trip_time: pair.currentRoundTripTime ?? null,
          };
        });
      const localCandidates = stats.filter((stat) => stat.type === "local-candidate").map((candidate) => ({
        candidate_type: candidate.candidateType || "unknown",
        protocol: candidate.protocol || null,
        is_mdns: typeof candidate.address === "string" && /\.local\.?$/i.test(candidate.address),
        relay_protocol: candidate.relayProtocol || null,
      }));
      const remoteCandidates = stats.filter((stat) => stat.type === "remote-candidate").map((candidate) => ({
        candidate_type: candidate.candidateType || "unknown",
        protocol: candidate.protocol || null,
        is_mdns: typeof candidate.address === "string" && /\.local\.?$/i.test(candidate.address),
        relay_protocol: candidate.relayProtocol || null,
      }));
      const audioStats = (type) => stats.filter((stat) => stat.type === type &&
        (stat.kind === "audio" || stat.mediaType === "audio")).map((stat) => ({
        bytes: type === "outbound-rtp" ? stat.bytesSent || 0 : stat.bytesReceived || 0,
        packets: type === "outbound-rtp" ? stat.packetsSent || 0 : stat.packetsReceived || 0,
        audio_level: stat.audioLevel ?? null,
        total_audio_energy: stat.totalAudioEnergy ?? null,
      }));
      return { candidate_pairs: candidatePairs, local_candidate_stats: localCandidates,
        remote_candidate_stats: remoteCandidates, outbound_audio: audioStats("outbound-rtp"),
        inbound_audio: audioStats("inbound-rtp") };
    } catch (error) {
      return { stats_error: errorName(error) };
    }
  }

  async getDiagnostics() {
    const peers = await Promise.all([...this.peers.values()].map(async (peer) => ({
      ...this._peerState(peer), ...(await this._peerStats(peer)),
    })));
    return { channel_id: this.channelId, session_id: this.sessionId,
      local_peer_id: this.selfPeerId, local_audio_track: trackSummary(this.localTrack),
      ice_servers: iceServerSummary(this.iceServers),
      recent_signals: [...this.sentSignals.entries()].map(([signal_id, signal]) => ({ signal_id, ...signal })),
      peers };
  }

  _logPeer(peer, event, details = {}) {
    this._log(event, { ...this._peerState(peer), ...details });
  }

  _isCurrentPeer(peer) {
    return !this.closed && this.peers.get(peer.peerId) === peer && peer.pc.connectionState !== "closed";
  }

  _sendSignal(peer, message, diagnosticDetails = {}) {
    const createdAt = Date.now();
    const id = signalId();
    const tracedMessage = { ...message, signal_id: id, created_at_ms: createdAt };
    const sent = safeSend(this.send, tracedMessage);
    const description = message.description;
    const safeDetails = {
      connection_id: message.connection_id || null,
      ...(description ? { description_type: description.type || null,
        description_length: typeof description.sdp === "string" ? description.sdp.length : null,
        description_candidates: sdpCandidateSummary(description) } : {}),
      ...diagnosticDetails,
    };
    if (sent) {
      this.sentSignals.set(id, { event_type: message.type, created_at_ms: createdAt,
        recipient_id: peer.peerId, socket_send_succeeded: true,
        server_outcome: "unknown_without_ack" });
      if (this.sentSignals.size > 128) this.sentSignals.delete(this.sentSignals.keys().next().value);
    }
    const eventName = message.type === "voice_ice_candidate" ? "ice.local.candidate_sent" : "signaling.sent_to_socket";
    this._logPeer(peer, sent ? eventName : "signaling.socket_send_failed", {
      event_type: message.type, signal_id: id, created_at_ms: createdAt, expires_at_ms: null,
      sender_id: this.selfPeerId, recipient_id: peer.peerId, accepted: null, ...safeDetails,
    });
    return sent;
  }

  _logReceivedSignal(message, accepted, rejectionReason = null, peer = null) {
    const details = {
      event_type: message?.type || null, signal_id: message?.signal_id || null,
      message_session_id: typeof message?.session_id === "string" ? message.session_id : null,
      connection_id: typeof message?.connection_id === "string" ? message.connection_id : null,
      description_type: message?.description?.type || null,
      description_length: typeof message?.description?.sdp === "string" ? message.description.sdp.length : null,
      description_candidates: sdpCandidateSummary(message?.description),
      created_at_ms: Number.isSafeInteger(message?.created_at_ms) ? message.created_at_ms : null,
      received_at_ms: Date.now(), expires_at_ms: null,
      sender_id: message?.from_peer_id || null, recipient_id: this.selfPeerId,
      sender_peer_known: Boolean(peer), recipient_session_active: Boolean(this.sessionId),
      accepted, rejection_reason: rejectionReason,
    };
    if (peer) this._logPeer(peer, accepted ? "signaling.received" : "signaling.rejected", details);
    else this._log("signaling.received_without_peer", details);
  }

  async _adoptRemoteAudioTransceiver(peer) {
    const transceivers = peer.pc.getTransceivers?.() || [];
    const transceiver = transceivers.find((item) => item?.mid != null && !item.stopped &&
      item.receiver?.track?.kind === "audio") || null;
    if (!transceiver) {
      this._logPeer(peer, "transceiver.adopt.unavailable", { transceiver_count: transceivers.length });
      return false;
    }
    try {
      if (transceiver.direction !== "sendrecv") transceiver.direction = "sendrecv";
    } catch (error) {
      this._logPeer(peer, "transceiver.adopt.direction_failed", { error: errorName(error) });
    }
    const changed = peer.transceiver !== transceiver;
    peer.transceiver = transceiver;
    if (changed || transceiver.sender?.track !== this.localTrack) {
      peer.trackReady = this._replaceLocalTrack(peer, this.localTrack);
      await peer.trackReady;
    }
    this._logPeer(peer, "transceiver.adopted", { transceiver_direction: transceiver.direction || "unknown",
      transceiver_count: transceivers.length });
    return true;
  }

  async _replaceLocalTrack(peer, track) {
    const sender = peer.transceiver?.sender;
    if (!sender?.replaceTrack) {
      this._logPeer(peer, peer.transceiver ? "sender.replace_track.unavailable" : "sender.replace_track.deferred",
        { track: trackSummary(track) });
      return false;
    }
    try {
      await sender.replaceTrack(track);
      this._logPeer(peer, "sender.replace_track.complete", { track: trackSummary(track) });
      return true;
    } catch (error) {
      this._logPeer(peer, "sender.replace_track.failed", { error: errorName(error), track: trackSummary(track) });
      return false;
    }
  }

  _negotiateWhenReady(peer, iceRestart = false) {
    if (peer.negotiationQueued) {
      if (iceRestart) peer.queuedIceRestart = true;
      return;
    }
    peer.negotiationQueued = true;
    void (async () => {
      try {
        let ready = peer.trackReady;
        await ready;
        if (ready !== peer.trackReady) await peer.trackReady;
        if (!this._isCurrentPeer(peer)) return;
        await this.negotiate(peer, iceRestart);
        if (peer.queuedIceRestart && !this.closed) {
          peer.queuedIceRestart = false;
          await this.negotiate(peer, true);
        }
      } finally {
        peer.negotiationQueued = false;
      }
    })();
  }

  addParticipant(participant) {
    const peerId = participant?.peer_id;
    if (!peerId || peerId === this.selfPeerId || this.closed || this.peers.has(peerId) || !this.PeerConnection) return;
    const pc = new this.PeerConnection({ iceServers: this.iceServers });
    // Only the offerer creates the audio transceiver. Browsers never associate a transceiver created by
    // addTransceiver() with a remote offer's m-line, so an answerer that pre-created one would leave its
    // microphone on an unnegotiated sender and answer recvonly. The answerer adopts the offer's transceiver.
    const isOfferer = this.selfPeerId < peerId;
    const transceiver = isOfferer ? pc.addTransceiver("audio", { direction: "sendrecv" }) : null;
    const peer = {
      peerId,
      pcInstanceId: signalId(),
      pc,
      transceiver,
      makingOffer: false,
      negotiationQueued: false,
      restartAttempted: false,
      remoteSdp: null,
      queuedCandidates: [],
      candidateKeys: new Set(),
      localCandidateCounts: { host: 0, srflx: 0, relay: 0, prflx: 0, end_of_candidates: 0, unknown: 0 },
      remoteCandidateCounts: { host: 0, srflx: 0, relay: 0, prflx: 0, end_of_candidates: 0, unknown: 0 },
      remoteCandidatesApplied: 0,
      candidateErrors: [],
      remoteTracks: new Map(),
      trackListeners: [],
    };
    this.peers.set(peerId, peer);
    peer.trackReady = transceiver ? this._replaceLocalTrack(peer, this.localTrack) : Promise.resolve(false);
    this._logPeer(peer, "peer.created", { role: isOfferer ? "offerer" : "answerer",
      transceiver_direction: transceiver?.direction || "awaiting_remote_offer" });
    pc.ontrack = (event) => {
      if (!this._isCurrentPeer(peer)) {
        this._logPeer(peer, "track.event.ignored", {
          reason: this.closed ? "manager_closed" : "peer_not_current",
          kind: event.track?.kind || null,
        });
        return;
      }
      const track = event.track;
      this._logPeer(peer, "track.received", { kind: track?.kind || "unknown",
        ready_state: track?.readyState || "unknown", muted: Boolean(track?.muted), stream_count: event.streams?.length || 0 });
      if (!track || track.kind !== "audio") return;
      peer.remoteTracks.set(track.id, trackSummary(track));
      const trackState = (state) => {
        peer.remoteTracks.set(track.id, { ...trackSummary(track), state });
        this._logPeer(peer, `track.${state}`);
      };
      for (const state of ["mute", "unmute", "ended"]) {
        const listener = () => trackState(state);
        track.addEventListener?.(state, listener);
        peer.trackListeners.push([track, state, listener]);
      }
      const stream = event.streams?.[0] || (globalThis.MediaStream ? new globalThis.MediaStream([track]) : null);
      if (stream) this.onRemoteStream(peerId, stream);
    };
    pc.onicecandidate = (event) => {
      if (!this._isCurrentPeer(peer)) {
        this._logPeer(peer, "ice.local.candidate_event.ignored", {
          reason: this.closed ? "manager_closed" : "peer_not_current",
          candidate_present: event.candidate !== null,
        });
        return;
      }
      if (event.candidate === null) {
        this._logPeer(peer, "ice.local.candidate_event", { candidate_present: false,
          candidate_type: null, candidate_length: null, send_status: "end_of_gathering" });
        void this._logStats(peer, "ice.local.gathering_complete");
        return;
      }
      let candidate;
      try {
        candidate = serializeIceCandidate(event.candidate);
      } catch (error) {
        this._logPeer(peer, "ice.local.candidate_serialization_failed", {
          error: errorName(error), candidate_present: true,
        });
        return;
      }
      if (!candidate || typeof candidate.candidate !== "string") {
        this._logPeer(peer, "ice.local.candidate_serialization_failed", {
          error: "InvalidCandidateShape", candidate_present: Boolean(candidate),
        });
        return;
      }
      const type = candidateType(candidate);
      peer.localCandidateCounts[type] = (peer.localCandidateCounts[type] || 0) + 1;
      const candidateText = candidate.candidate;
      this._sendSignal(peer, {
        type: "voice_ice_candidate",
        session_id: this.sessionId,
        to_peer_id: peerId,
        connection_id: voiceConnectionId(this.selfPeerId, peerId),
        candidate,
      }, {
        candidate_type: type, candidate_length: candidateText.length,
        candidate_is_mdns: /\.local\b/i.test(candidateText),
        username_fragment_present: typeof candidate.usernameFragment === "string",
      });
    };
    pc.onicecandidateerror = (event) => {
      if (this.closed || this.peers.get(peerId) !== peer) return;
      const entry = { code: Number.isFinite(event.errorCode) ? event.errorCode : null,
        url: iceServerSummary([{ urls: [event.url] }])[0]?.urls?.[0] || null };
      peer.candidateErrors.push(entry);
      if (peer.candidateErrors.length > 8) peer.candidateErrors.shift();
      this._logPeer(peer, "ice.candidate.error", entry);
    };
    pc.oniceconnectionstatechange = () => {
      if (this.closed || this.peers.get(peerId) !== peer) return;
      this._logPeer(peer, "ice.connection_state.change");
      void this._logStats(peer, "ice.connection_state.change");
    };
    pc.onicegatheringstatechange = () => {
      if (this.closed || this.peers.get(peerId) !== peer) return;
      this._logPeer(peer, pc.iceGatheringState === "complete" ? "ice.gathering.complete" : "ice.gathering_state.change");
      if (pc.iceGatheringState === "complete") void this._logStats(peer, "ice.gathering.complete");
    };
    pc.onsignalingstatechange = () => {
      if (!this.closed && this.peers.get(peerId) === peer) this._logPeer(peer, "signaling_state.change");
    };
    pc.onconnectionstatechange = () => {
      if (this.closed || this.peers.get(peerId) !== peer) return;
      this.onPeerState(peerId, pc.connectionState || "new");
      this._logPeer(peer, "connection_state.change");
      void this._logStats(peer, "connection_state.change");
      if (pc.connectionState === "failed" && !peer.restartAttempted && this.selfPeerId < peerId) {
        peer.restartAttempted = true;
        try { pc.restartIce?.(); } catch { /* unsupported by older WebRTC implementations */ }
        this._negotiateWhenReady(peer, true);
      }
    };
    pc.onnegotiationneeded = () => {
      if (!this.closed && this.peers.get(peerId) === peer && this.selfPeerId < peerId) this._negotiateWhenReady(peer);
    };
    this.onPeerState(peerId, pc.connectionState || "new");
    if (this.selfPeerId < peerId) this._negotiateWhenReady(peer);
  }

  syncParticipants(participants = []) {
    if (this.closed || !Array.isArray(participants)) return;
    const current = new Map(participants.filter((participant) =>
      typeof participant?.peer_id === "string" && participant.peer_id !== this.selfPeerId)
      .map((participant) => [participant.peer_id, participant]));
    const removed = [...this.peers.keys()].filter((peerId) => !current.has(peerId));
    const added = [...current.keys()].filter((peerId) => !this.peers.has(peerId));
    removed.forEach((peerId) => this.removeParticipant(peerId));
    added.forEach((peerId) => this.addParticipant(current.get(peerId)));
    this._log("peer.presence.reconciled", {
      added_peer_ids: added, removed_peer_ids: removed, active_peer_ids: [...current.keys()],
    });
  }

  async _logStats(peer, event) {
    if (!this.diagnosticsEnabled || this.closed || !peer.pc.getStats) return;
    const snapshot = await this._peerStats(peer);
    this._log(event, { ...this._peerState(peer), ...snapshot });
  }

  async _applyQueuedCandidates(peer) {
    const queued = peer.queuedCandidates.splice(0);
    for (const queuedCandidate of queued) {
      const { candidate, signalId: signal_id } = queuedCandidate;
      if (!this._isCurrentPeer(peer)) {
        this._logPeer(peer, "ice.remote.buffered_candidate.dropped", {
          signal_id, candidate_type: candidateType(candidate), reason: "peer_instance_stale",
        });
        break;
      }
      try {
        await peer.pc.addIceCandidate(candidate);
        if (!this._isCurrentPeer(peer)) continue;
        peer.remoteCandidatesApplied += 1;
        this._logPeer(peer, "ice.remote.buffered_candidate.applied", {
          signal_id, candidate_type: candidateType(candidate),
        });
      } catch (error) {
        this._logPeer(peer, "ice.remote.buffered_candidate.failed", {
          signal_id, candidate_type: candidateType(candidate), error: errorName(error),
        });
      }
    }
  }

  async negotiate(peer, iceRestart = false) {
    const { pc, peerId } = peer;
    if (!this._isCurrentPeer(peer) || this.selfPeerId > peerId || peer.makingOffer || pc.signalingState !== "stable") return;
    peer.makingOffer = true;
    try {
      const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      if (!this._isCurrentPeer(peer) || pc.signalingState !== "stable") return;
      this._logPeer(peer, "sdp.offer.created", { ice_restart: Boolean(iceRestart) });
      await pc.setLocalDescription(offer);
      if (!this._isCurrentPeer(peer)) return;
      this._logPeer(peer, "sdp.local_description.set", { description_type: pc.localDescription?.type || offer.type });
      const sent = this._sendSignal(peer, {
        type: "voice_offer", session_id: this.sessionId, to_peer_id: peerId,
        connection_id: voiceConnectionId(this.selfPeerId, peerId),
        description: pc.localDescription || offer,
      });
      this._logPeer(peer, sent ? "sdp.offer.sent" : "sdp.offer.send_failed");
    } catch (error) {
      this._logPeer(peer, "sdp.offer.failed", { error: errorName(error) });
      this.onPeerState(peerId, "failed");
    } finally {
      peer.makingOffer = false;
    }
  }

  async receive(message) {
    if (this.closed) return;
    if (message.type === "voice_peer_joined") {
      this.addParticipant(message.participant);
      return;
    }
    if (message.type === "voice_peer_left") {
      this.removeParticipant(message.peer_id);
      return;
    }
    const receivedAt = Date.now();
    if (message?.session_id !== this.sessionId) {
      this._logReceivedSignal(message, false, "session_id_mismatch");
      return;
    }
    const peerId = message.from_peer_id;
    const peer = this.peers.get(peerId);
    if (!peer) {
      this._logReceivedSignal(message, false, "sender_peer_not_found");
      return;
    }
    if (message.connection_id !== voiceConnectionId(this.selfPeerId, peerId)) {
      this._logReceivedSignal(message, false, "connection_id_mismatch", peer);
      return;
    }
    this._logReceivedSignal({ ...message, received_at_ms: receivedAt }, true, null, peer);
    if (message.type === "voice_offer") {
      if (peerId > this.selfPeerId || !message.description?.sdp ||
          (peer.remoteSdp === message.description.sdp && peer.pc.remoteDescription?.type === "offer")) {
        this._logPeer(peer, "sdp.offer.ignored", { signal_id: message.signal_id || null,
          reason: "duplicate_or_invalid_negotiation_order" });
        return;
      }
      try {
        await peer.pc.setRemoteDescription(message.description);
        if (!this._isCurrentPeer(peer)) {
          this._logPeer(peer, "sdp.offer.abandoned", { signal_id: message.signal_id || null,
            reason: "peer_instance_stale" });
          return;
        }
        peer.remoteSdp = message.description.sdp;
        this._logPeer(peer, "sdp.remote_description.set", { signal_id: message.signal_id || null,
          description_type: peer.pc.remoteDescription?.type || message.description.type });
        await this._adoptRemoteAudioTransceiver(peer);
        if (!this._isCurrentPeer(peer)) {
          this._logPeer(peer, "sdp.answer.abandoned", { signal_id: message.signal_id || null,
            reason: "peer_instance_stale" });
          return;
        }
        await this._applyQueuedCandidates(peer);
        if (!this._isCurrentPeer(peer)) {
          this._logPeer(peer, "sdp.answer.abandoned", { signal_id: message.signal_id || null,
            reason: "peer_instance_stale" });
          return;
        }
        const answer = await peer.pc.createAnswer();
        if (!this._isCurrentPeer(peer)) {
          this._logPeer(peer, "sdp.answer.abandoned", { signal_id: message.signal_id || null,
            reason: "peer_instance_stale" });
          return;
        }
        await peer.pc.setLocalDescription(answer);
        if (!this._isCurrentPeer(peer)) {
          this._logPeer(peer, "sdp.answer.abandoned", { signal_id: message.signal_id || null,
            reason: "peer_instance_stale" });
          return;
        }
        this._logPeer(peer, "sdp.local_description.set", { signal_id: message.signal_id || null,
          description_type: peer.pc.localDescription?.type || answer.type });
        const sent = this._sendSignal(peer, {
          type: "voice_answer", session_id: this.sessionId, to_peer_id: peerId,
          connection_id: voiceConnectionId(this.selfPeerId, peerId),
          description: peer.pc.localDescription || answer,
        });
        this._logPeer(peer, sent ? "sdp.answer.sent" : "sdp.answer.send_failed");
      } catch (error) {
        this._logPeer(peer, "sdp.answer.failed", { signal_id: message.signal_id || null, error: errorName(error) });
        this.onPeerState(peerId, "failed");
      }
    } else if (message.type === "voice_answer") {
      if (peerId < this.selfPeerId || !message.description?.sdp ||
          peer.pc.signalingState !== "have-local-offer" || peer.remoteSdp === message.description.sdp) {
        this._logPeer(peer, "sdp.answer.ignored", { signal_id: message.signal_id || null,
          reason: "duplicate_or_unexpected_answer" });
        return;
      }
      try {
        await peer.pc.setRemoteDescription(message.description);
        if (!this._isCurrentPeer(peer)) {
          this._logPeer(peer, "sdp.answer.abandoned", { signal_id: message.signal_id || null,
            reason: "peer_instance_stale" });
          return;
        }
        peer.remoteSdp = message.description.sdp;
        this._logPeer(peer, "sdp.remote_description.set", { description_type: peer.pc.remoteDescription?.type || message.description.type });
        await this._applyQueuedCandidates(peer);
      } catch (error) {
        this._logPeer(peer, "sdp.remote_answer.failed", { signal_id: message.signal_id || null,
          error: errorName(error) });
        this.onPeerState(peerId, "failed");
      }
    } else if (message.type === "voice_ice_candidate") {
      const candidate = message.candidate;
      if (!candidate || typeof candidate.candidate !== "string") {
        this._logReceivedSignal(message, false, "candidate_payload_invalid", peer);
        return;
      }
      const key = JSON.stringify(candidate);
      if (peer.candidateKeys.has(key)) {
        this._logPeer(peer, "ice.remote.candidate.duplicate", {
          signal_id: message.signal_id || null, candidate_type: candidateType(candidate),
        });
        return;
      }
      peer.candidateKeys.add(key);
      if (peer.candidateKeys.size > 128) peer.candidateKeys.delete(peer.candidateKeys.values().next().value);
      const type = candidateType(candidate);
      peer.remoteCandidateCounts[type] = (peer.remoteCandidateCounts[type] || 0) + 1;
      if (!peer.pc.remoteDescription) {
        if (peer.queuedCandidates.length < 128) {
          peer.queuedCandidates.push({ candidate, signalId: message.signal_id || null });
          this._logPeer(peer, "ice.remote.candidate.buffered", {
            signal_id: message.signal_id || null, candidate_type: type,
          });
        } else {
          this._logPeer(peer, "ice.remote.candidate.dropped", {
            signal_id: message.signal_id || null, candidate_type: type, reason: "buffer_full",
          });
        }
        return;
      }
      try {
        await peer.pc.addIceCandidate(candidate);
        if (!this._isCurrentPeer(peer)) return;
        peer.remoteCandidatesApplied += 1;
        this._logPeer(peer, "ice.remote.candidate.applied", {
          signal_id: message.signal_id || null, candidate_type: type,
        });
      } catch (error) {
        this._logPeer(peer, "ice.remote.candidate.failed", {
          signal_id: message.signal_id || null, candidate_type: type, error: errorName(error),
        });
      }
    }
  }

  handleSignalError(message) {
    const signalId = message?.signal_id;
    const sentSignal = typeof signalId === "string" ? this.sentSignals.get(signalId) : null;
    if (sentSignal) this.sentSignals.set(signalId, { ...sentSignal, server_outcome: "rejected" });
    this._log("signaling.server_rejected", {
      event_type: sentSignal?.event_type || null,
      signal_id: signalId || null,
      created_at_ms: sentSignal?.created_at_ms || null,
      received_at_ms: Date.now(),
      expires_at_ms: null,
      sender_id: this.selfPeerId,
      recipient_id: sentSignal?.recipient_id || null,
      accepted: false,
      rejection_reason: "server_rejected_signal",
    });
  }

  removeParticipant(peerId, notify = true) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this._logPeer(peer, "peer.closed");
    this.peers.delete(peerId);
    for (const [track, event, listener] of peer.trackListeners) {
      track.removeEventListener?.(event, listener);
    }
    peer.trackListeners = [];
    try {
      peer.pc.ontrack = null;
      peer.pc.onicecandidate = null;
      peer.pc.onicecandidateerror = null;
      peer.pc.oniceconnectionstatechange = null;
      peer.pc.onicegatheringstatechange = null;
      peer.pc.onsignalingstatechange = null;
      peer.pc.onconnectionstatechange = null;
      peer.pc.onnegotiationneeded = null;
      peer.pc.close();
    } catch { /* already closed */ }
    if (notify) {
      this.onRemoteStream(peerId, null);
      this.onPeerState(peerId, "closed");
    }
  }

  restartOffererPeers() {
    for (const peer of this.peers.values()) {
      if (this.selfPeerId < peer.peerId && ["failed", "disconnected"].includes(peer.pc.connectionState)) {
        try { peer.pc.restartIce?.(); } catch { /* optional browser feature */ }
        this._logPeer(peer, "ice.restart.requested", { trigger: "network_online" });
        this._negotiateWhenReady(peer, true);
      }
    }
  }

  close() {
    this.closed = true;
    for (const peerId of [...this.peers.keys()]) this.removeParticipant(peerId, false);
    diagnosticManagers.delete(this);
    if (this.diagnosticsEnabled && typeof globalThis.window !== "undefined" && diagnosticManagers.size === 0 &&
        globalThis.window.__dehlaPakadVoiceDiagnostics === diagnosticSnapshot) {
      delete globalThis.window.__dehlaPakadVoiceDiagnostics;
    }
    this.sessionId = null;
    this.selfPeerId = null;
    this.localTrack = null;
    this.sentSignals.clear();
  }
}

export function voicePermissionMessage(error) {
  if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError") {
    return "Microphone permission was denied. You can still listen in voice chat.";
  }
  if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") {
    return "No microphone was found. You can still listen in voice chat.";
  }
  return "Microphone unavailable. You can still listen in voice chat.";
}
