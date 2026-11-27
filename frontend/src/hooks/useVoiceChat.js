import { useCallback, useEffect, useRef, useState } from "react";
import { useApp, useSocketEvent } from "@/context/AppContext";
import { VoicePeerManager, logVoiceDiagnostic, voicePermissionMessage } from "@/services/voiceService";

function stopStream(stream) {
  stream?.getTracks?.().forEach((track) => track.stop());
}

function newJoinRequestId() {
  try { return globalThis.crypto?.randomUUID?.() || `join-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`; }
  catch { return `join-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`; }
}

export function useVoiceChat({ gameId, roomCode, eligible = true }) {
  const { me, send, connected } = useApp();
  const [status, setStatus] = useState("not-joined");
  const [participants, setParticipants] = useState([]);
  const [remoteStreams, setRemoteStreams] = useState({});
  const [peerStates, setPeerStates] = useState({});
  const [micMuted, setMicMuted] = useState(true);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [message, setMessage] = useState("");
  const joinedRef = useRef(false);
  const joiningRef = useRef(false);
  const connectedRef = useRef(connected);
  const sessionRef = useRef(null);
  const selfPeerRef = useRef(null);
  const managerRef = useRef(null);
  const streamRef = useRef(null);
  const analyzerRef = useRef(null);
  const joinTimeoutRef = useRef(null);
  const attemptRef = useRef(0);
  // Correlates server replies with the join attempt that is currently pending, so a late
  // voice_joined/voice_error from an earlier (cancelled) attempt cannot hijack a newer one.
  const joinRequestRef = useRef(null);

  const stopAnalyzer = useCallback(() => {
    const current = analyzerRef.current;
    if (!current) return;
    if (current.raf) cancelAnimationFrame(current.raf);
    try { current.source.disconnect(); current.analyser.disconnect(); } catch { /* already disconnected */ }
    const closing = current.context.close?.();
    closing?.catch?.(() => {});
    analyzerRef.current = null;
  }, []);

  const startAnalyzer = useCallback((stream) => {
    stopAnalyzer();
    const AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!stream || !AudioContextImpl || typeof requestAnimationFrame !== "function") return;
    try {
      const context = new AudioContextImpl();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const current = { context, source, analyser, raf: null, speaking: false, aboveAt: 0, belowAt: 0 };
      analyzerRef.current = current;
      const sample = (time) => {
        if (analyzerRef.current !== current) return;
        analyser.getByteTimeDomainData(samples);
        let energy = 0;
        for (const value of samples) {
          const normalized = (value - 128) / 128;
          energy += normalized * normalized;
        }
        const rms = Math.sqrt(energy / samples.length);
        if (rms > 0.035) {
          current.belowAt = 0;
          current.aboveAt ||= time;
          if (!current.speaking && time - current.aboveAt > 180) {
            current.speaking = true;
            if (sessionRef.current) send({ type: "voice_speaking_changed", session_id: sessionRef.current, speaking: true });
          }
        } else {
          current.aboveAt = 0;
          current.belowAt ||= time;
          if (current.speaking && time - current.belowAt > 500) {
            current.speaking = false;
            if (sessionRef.current) send({ type: "voice_speaking_changed", session_id: sessionRef.current, speaking: false });
          }
        }
        current.raf = requestAnimationFrame(sample);
      };
      current.raf = requestAnimationFrame(sample);
    } catch { /* Speaking state is optional on browsers without Web Audio support. */ }
  }, [send, stopAnalyzer]);

  const disposeLocalMedia = useCallback(() => {
    stopAnalyzer();
    stopStream(streamRef.current);
    streamRef.current = null;
    managerRef.current?.close();
    managerRef.current = null;
  }, [stopAnalyzer]);

  const stopLocalMedia = useCallback(() => {
    disposeLocalMedia();
    setRemoteStreams({});
    setPeerStates({});
    setMicMuted(true);
  }, [disposeLocalMedia]);

  const leave = useCallback(() => {
    attemptRef.current += 1;
    if (joinTimeoutRef.current) clearTimeout(joinTimeoutRef.current);
    joinTimeoutRef.current = null;
    const wasJoining = joiningRef.current;
    joiningRef.current = false;
    joinRequestRef.current = null;
    const sessionId = sessionRef.current;
    if ((sessionId || wasJoining) && connected) {
      send({ type: "voice_leave", ...(sessionId ? { session_id: sessionId } : {}) });
    }
    joinedRef.current = false;
    sessionRef.current = null;
    selfPeerRef.current = null;
    stopLocalMedia();
    setParticipants([]);
    setMessage("");
    setStatus("not-joined");
  }, [connected, send, stopLocalMedia]);

  const join = useCallback(async () => {
    if (!eligible || !connected || joinedRef.current || joiningRef.current) return;
    if (!gameId && !roomCode) return;
    if (typeof globalThis.RTCPeerConnection !== "function") {
      setStatus("failed");
      setMessage("This browser does not support WebRTC voice chat.");
      return;
    }
    joiningRef.current = true;
    const attempt = ++attemptRef.current;
    setStatus("connecting");
    setMessage("");
    let stream = null;
    const mediaDevices = globalThis.navigator?.mediaDevices;
    if (mediaDevices?.getUserMedia) {
      try {
        stream = await mediaDevices.getUserMedia({ audio: true, video: false });
      } catch (error) {
        setMessage(voicePermissionMessage(error));
        logVoiceDiagnostic("microphone.capture.failed", {
          channel_id: gameId || roomCode, permission_error: error?.name || "UnknownError",
          audio_track_count: 0,
        });
      }
    } else {
      setMessage("Microphone access is unavailable here. You can still listen if WebRTC is supported.");
      logVoiceDiagnostic("microphone.capture.unavailable", { channel_id: gameId || roomCode, audio_track_count: 0 });
    }
    if (attempt !== attemptRef.current || !joiningRef.current) {
      stopStream(stream);
      return;
    }
    streamRef.current = stream;
    const audioTracks = stream?.getAudioTracks?.() || [];
    audioTracks.forEach((track) => { track.enabled = true; });
    if (stream) {
      logVoiceDiagnostic("microphone.capture.succeeded", {
        channel_id: gameId || roomCode, permission_state: "granted", audio_track_count: audioTracks.length,
        tracks: audioTracks.map((track) => ({ kind: track.kind, ready_state: track.readyState,
          enabled: Boolean(track.enabled), muted: Boolean(track.muted) })),
      });
    }
    const selector = gameId ? { game_id: gameId } : { room_code: roomCode };
    const requestId = newJoinRequestId();
    joinRequestRef.current = requestId;
    if (!send({ type: "voice_join", ...selector, request_id: requestId })) {
      joiningRef.current = false;
      joinRequestRef.current = null;
      stopStream(streamRef.current);
      streamRef.current = null;
      setStatus("failed");
      setMessage("The game connection is unavailable. Reconnect and try again.");
      return;
    }
    joinTimeoutRef.current = setTimeout(() => {
      if (!joinedRef.current && joiningRef.current && joinRequestRef.current === requestId) {
        joiningRef.current = false;
        joinRequestRef.current = null;
        stopStream(streamRef.current);
        streamRef.current = null;
        setStatus("failed");
        setMessage("Voice did not connect. Check your connection and try again.");
      }
    }, 10000);
  }, [connected, eligible, gameId, roomCode, send]);

  const toggleMic = useCallback(async () => {
    if (!joinedRef.current) return;
    if (!streamRef.current) {
      const mediaDevices = globalThis.navigator?.mediaDevices;
      if (!mediaDevices?.getUserMedia) {
        setMessage("Microphone access is unavailable in this browser.");
        return;
      }
      try {
        const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
        if (!joinedRef.current) { stopStream(stream); return; }
        streamRef.current = stream;
        managerRef.current?.setLocalStream(stream);
        stream.getAudioTracks().forEach((track) => { track.enabled = true; });
        logVoiceDiagnostic("microphone.unmuted", {
          channel_id: gameId || roomCode, session_id: sessionRef.current,
          tracks: stream.getAudioTracks().map((track) => ({ kind: track.kind, ready_state: track.readyState,
            enabled: Boolean(track.enabled), muted: Boolean(track.muted) })),
        });
        setMicMuted(false);
        setMessage("");
        if (sessionRef.current) send({ type: "voice_mute_changed", session_id: sessionRef.current, muted: false });
        startAnalyzer(stream);
      } catch (error) {
        setMessage(voicePermissionMessage(error));
      }
      return;
    }
    const nextMuted = !micMuted;
    streamRef.current.getAudioTracks().forEach((track) => { track.enabled = !nextMuted; });
    logVoiceDiagnostic(nextMuted ? "microphone.muted" : "microphone.unmuted", {
      channel_id: gameId || roomCode, session_id: sessionRef.current,
      tracks: streamRef.current.getAudioTracks().map((track) => ({ kind: track.kind, ready_state: track.readyState,
        enabled: Boolean(track.enabled), muted: Boolean(track.muted) })),
    });
    setMicMuted(nextMuted);
    if (sessionRef.current) {
      send({ type: "voice_mute_changed", session_id: sessionRef.current, muted: nextMuted });
      if (nextMuted) send({ type: "voice_speaking_changed", session_id: sessionRef.current, speaking: false });
    }
    if (nextMuted) stopAnalyzer();
    else startAnalyzer(streamRef.current);
  }, [gameId, micMuted, roomCode, send, startAnalyzer, stopAnalyzer]);

  const toggleSpeaker = useCallback(() => setSpeakerMuted((muted) => !muted), []);

  useSocketEvent((event) => {
    if (event.type === "voice_joined") {
      if (!joiningRef.current || !event.session_id || !event.self_peer_id) return;
      if (event.request_id && event.request_id !== joinRequestRef.current) {
        logVoiceDiagnostic("join.stale_response_ignored", { channel_id: gameId || roomCode,
          session_id: event.session_id, self_peer_id: event.self_peer_id });
        return;
      }
      if (joinTimeoutRef.current) clearTimeout(joinTimeoutRef.current);
      joinTimeoutRef.current = null;
      joiningRef.current = false;
      joinRequestRef.current = null;
      joinedRef.current = true;
      // Defensive: never keep peer connections from an earlier membership alive.
      managerRef.current?.close();
      managerRef.current = null;
      sessionRef.current = event.session_id;
      selfPeerRef.current = event.self_peer_id;
      const local = {
        peer_id: event.self_peer_id,
        display_name: me?.display_name || me?.username || "You",
        avatar_color: me?.avatar_color,
        avatar_icon: me?.avatar_icon,
        role: "player",
        muted: !streamRef.current,
        speaking: false,
        self: true,
      };
      setParticipants([local, ...(Array.isArray(event.participants) ? event.participants : [])]);
      setStatus("connected");
      const manager = new VoicePeerManager({
        send,
        channelId: gameId || roomCode,
        onRemoteStream: (peerId, stream) => setRemoteStreams((current) => {
          const next = { ...current };
          if (stream) next[peerId] = stream;
          else delete next[peerId];
          return next;
        }),
        onPeerState: (peerId, state) => setPeerStates((current) => ({ ...current, [peerId]: state })),
      });
      managerRef.current = manager;
      manager.start({ sessionId: event.session_id, selfPeerId: event.self_peer_id,
        participants: Array.isArray(event.participants) ? event.participants : [],
        iceServers: event.ice_servers, stream: streamRef.current });
      const initialMuted = !streamRef.current;
      setMicMuted(initialMuted);
      send({ type: "voice_mute_changed", session_id: event.session_id, muted: initialMuted });
      if (streamRef.current) startAnalyzer(streamRef.current);
    } else if (event.type === "voice_presence" && event.session_id === sessionRef.current) {
      if (Array.isArray(event.participants)) {
        logVoiceDiagnostic("presence.snapshot_received", {
          channel_id: gameId || roomCode, session_id: event.session_id,
          self_peer_id: selfPeerRef.current,
          peer_ids: event.participants.map((participant) => participant.peer_id).filter(Boolean),
          roles: event.participants.filter((participant) => participant?.peer_id)
            .map((participant) => ({ peer_id: participant.peer_id, role: participant.role })),
        });
        managerRef.current?.syncParticipants(event.participants);
        setParticipants(event.participants.map((participant) => ({
          ...participant, self: participant.peer_id === selfPeerRef.current,
        })));
      }
    } else if (event.type === "voice_peer_joined" && event.session_id === sessionRef.current) {
      const participant = event.participant;
      if (!participant?.peer_id) return;
      logVoiceDiagnostic("presence.peer_joined", { channel_id: gameId || roomCode,
        session_id: event.session_id, peer_id: participant.peer_id, role: participant.role });
      setParticipants((current) => current.some((item) => item.peer_id === participant.peer_id)
        ? current : [...current, participant]);
      void managerRef.current?.receive(event);
    } else if (event.type === "voice_peer_left" && event.session_id === sessionRef.current) {
      logVoiceDiagnostic("presence.peer_left", { channel_id: gameId || roomCode,
        session_id: event.session_id, peer_id: event.peer_id });
      setParticipants((current) => current.filter((participant) => participant.peer_id !== event.peer_id));
      void managerRef.current?.receive(event);
    } else if (["voice_offer", "voice_answer", "voice_ice_candidate"].includes(event.type)) {
      void managerRef.current?.receive(event);
    } else if (event.type === "voice_error") {
      managerRef.current?.handleSignalError(event);
      logVoiceDiagnostic("signaling.server_error", {
        channel_id: gameId || roomCode, session_id: sessionRef.current,
        signal_id: event.signal_id || null, received_at_ms: Date.now(),
        expires_at_ms: null,
      });
      // A join fails only on an error for the pending join request. Errors for earlier signals or a
      // cancelled attempt (which carry a different signal_id/request_id) must not abort it.
      const forPendingJoin = joiningRef.current && !event.signal_id &&
        (event.request_id ? event.request_id === joinRequestRef.current : true);
      if (joiningRef.current && !forPendingJoin) return;
      setMessage(event.message || "Voice request failed.");
      if (forPendingJoin) {
        joiningRef.current = false;
        joinRequestRef.current = null;
        if (joinTimeoutRef.current) clearTimeout(joinTimeoutRef.current);
        joinTimeoutRef.current = null;
        stopLocalMedia();
        setStatus("failed");
      }
    } else if (event.type === "voice_left" && joinedRef.current) {
      // Ignore the late reply to an earlier leave (or a removal of a previous membership). While a new
      // join is pending joinedRef is false, so such replies are dropped before reaching this branch.
      if (event.peer_id && event.peer_id !== selfPeerRef.current) {
        logVoiceDiagnostic("leave.stale_response_ignored", { channel_id: gameId || roomCode,
          session_id: sessionRef.current });
        return;
      }
      joinedRef.current = false;
      joiningRef.current = false;
      sessionRef.current = null;
      selfPeerRef.current = null;
      stopLocalMedia();
      setParticipants([]);
      setStatus("not-joined");
      if (event.message) setMessage(event.message);
    }
  });

  useEffect(() => {
    if (!eligible && (joinedRef.current || joiningRef.current)) leave();
  }, [eligible, leave]);

  useEffect(() => {
    if (connectedRef.current && !connected && (joinedRef.current || joiningRef.current)) {
      logVoiceDiagnostic("signaling.websocket_lost", { channel_id: gameId || roomCode,
        session_id: sessionRef.current });
      attemptRef.current += 1;
      joiningRef.current = false;
      joinRequestRef.current = null;
      joinedRef.current = false;
      sessionRef.current = null;
      selfPeerRef.current = null;
      if (joinTimeoutRef.current) clearTimeout(joinTimeoutRef.current);
      joinTimeoutRef.current = null;
      stopLocalMedia();
      setParticipants([]);
      setStatus("reconnecting");
      setMessage("Connection lost. Rejoin voice to continue; your microphone will stay off until then.");
    }
    connectedRef.current = connected;
  }, [connected, gameId, roomCode, stopLocalMedia]);

  useEffect(() => {
    const onOnline = () => managerRef.current?.restartOffererPeers();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  useEffect(() => () => {
    const sessionId = sessionRef.current;
    if (sessionId && connected) send({ type: "voice_leave", session_id: sessionId });
    attemptRef.current += 1;
    if (joinTimeoutRef.current) clearTimeout(joinTimeoutRef.current);
    disposeLocalMedia();
  }, [connected, send, disposeLocalMedia]);

  return {
    status, participants, remoteStreams, peerStates, micMuted, speakerMuted, message, sessionId: sessionRef.current,
    join, leave, toggleMic, toggleSpeaker, connected,
  };
}
