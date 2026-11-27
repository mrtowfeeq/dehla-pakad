import { useCallback, useEffect, useRef, useState } from "react";
import { Headphones, Mic, MicOff, Radio, Volume2, VolumeX, Wifi, WifiOff, X } from "lucide-react";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { useVoiceChat } from "@/hooks/useVoiceChat";
import { logVoiceDiagnostic } from "@/services/voiceService";

const STATUS_LABEL = {
  "not-joined": "Not joined",
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting · rejoin to continue",
  failed: "Connection failed",
};

function RemoteAudio({ stream, muted, peerId, channelId, register, onPlaybackBlocked }) {
  const audioRef = useRef(null);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    register(peerId, audio);
    audio.srcObject = stream || null;
    const tracks = stream?.getAudioTracks?.() || [];
    logVoiceDiagnostic("remote.audio.attached", {
      channel_id: channelId, remote_peer_id: peerId, element_connected: audio.isConnected, muted: audio.muted,
      volume: audio.volume, audio_track_count: tracks.length,
      tracks: tracks.map((track) => ({ kind: track.kind, ready_state: track.readyState, muted: Boolean(track.muted) })),
    });
    const onPlaying = () => logVoiceDiagnostic("remote.audio.playing", {
      channel_id: channelId, remote_peer_id: peerId, element_connected: audio.isConnected, muted: audio.muted, volume: audio.volume,
    });
    audio.addEventListener("playing", onPlaying);
    if (stream) {
      try {
        const playback = audio.play?.();
        if (playback?.then) {
          playback.then(() => logVoiceDiagnostic("remote.audio.play_succeeded", {
            channel_id: channelId, remote_peer_id: peerId, element_connected: audio.isConnected, muted: audio.muted, volume: audio.volume,
          })).catch((error) => {
            logVoiceDiagnostic("remote.audio.play_rejected", { channel_id: channelId, remote_peer_id: peerId, error: error?.name || "PlaybackError" });
            onPlaybackBlocked(true);
          });
        } else {
          logVoiceDiagnostic("remote.audio.play_invoked", { channel_id: channelId, remote_peer_id: peerId, element_connected: audio.isConnected });
        }
      } catch (error) {
        logVoiceDiagnostic("remote.audio.play_rejected", { channel_id: channelId, remote_peer_id: peerId, error: error?.name || "PlaybackError" });
        onPlaybackBlocked(true);
      }
    }
    return () => {
      audio.removeEventListener("playing", onPlaying);
      register(peerId, null);
      if (audio) audio.srcObject = null;
    };
  }, [stream, peerId, channelId, register, onPlaybackBlocked]);
  return <audio ref={audioRef} autoPlay playsInline muted={muted} data-testid={`voice-audio-${peerId}`} />;
}

// variant "pill" (default) is the compact header button used at the game table; "fab" is a round
// floating button (lobby table corner) whose controls open upward from the button's left edge.
export function VoicePanel({ gameId, roomCode, eligible = true, className = "", variant = "pill" }) {
  const fab = variant === "fab";
  const voice = useVoiceChat({ gameId, roomCode, eligible });
  const channelId = gameId || roomCode;
  const [expanded, setExpanded] = useState(false);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const audioElements = useRef(new Map());
  const inVoice = voice.status === "connected" || voice.status === "connecting";
  const statusTone = voice.status === "connected" ? "text-emerald-200" :
    voice.status === "failed" ? "text-rose-200" : voice.status === "reconnecting" ? "text-amber-200" : "text-white/65";
  const registerAudio = useCallback((peerId, element) => {
    if (element) audioElements.current.set(peerId, element);
    else audioElements.current.delete(peerId);
  }, []);
  const playRemoteAudio = () => {
    const attempts = [...audioElements.current.values()].map((audio) => {
      audio.muted = false;
      return Promise.resolve(audio.play?.());
    });
    Promise.all(attempts).then(() => {
      logVoiceDiagnostic("remote.audio.play_retry_succeeded", { channel_id: channelId, session_id: voice.sessionId,
        audio_element_count: audioElements.current.size });
      setPlaybackBlocked(false);
    }).catch((error) => {
      logVoiceDiagnostic("remote.audio.play_retry_rejected", { channel_id: channelId, session_id: voice.sessionId,
        error: error?.name || "PlaybackError" });
      setPlaybackBlocked(true);
    });
  };
  const toggleSpeaker = () => {
    logVoiceDiagnostic(voice.speakerMuted ? "speaker.unmuted" : "speaker.muted", { session_id: voice.sessionId });
    if (voice.speakerMuted) {
      voice.toggleSpeaker();
      playRemoteAudio();
    } else if (playbackBlocked) {
      playRemoteAudio();
    } else {
      voice.toggleSpeaker();
    }
  };

  return (
    <div className={`relative ${className}`} data-testid="voice-panel">
      {fab ? (
        <button type="button" aria-expanded={expanded} aria-controls="voice-panel-content"
          onClick={() => setExpanded((open) => !open)} data-testid="voice-panel-toggle"
          aria-label={voice.status === "connected" ? `Voice chat, connected, ${voice.participants.length} in channel` : "Voice chat"}
          className={`relative flex h-14 w-14 items-center justify-center rounded-full border-2 shadow-[0_10px_24px_-8px_rgba(0,0,0,.95)] transition-transform hover:scale-105 active:scale-95 ${expanded
            ? "border-amber-100/70 bg-gradient-to-br from-amber-200 to-amber-500 text-slate-950"
            : voice.status === "connected" ? "border-emerald-300/70 bg-gradient-to-br from-emerald-700 to-emerald-950 text-emerald-100"
              : "border-amber-300/50 bg-gradient-to-br from-[#1b2a4a] to-[#0a1120] text-amber-200"}`}>
          {expanded ? <X size={22} /> : voice.status === "connected" ? (voice.micMuted ? <MicOff size={22} /> : <Mic size={22} />) : <Headphones size={22} />}
          {!expanded && voice.status === "connected" && (
            <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-[#0a1120] bg-emerald-500 px-1 text-[10px] font-black text-white">{voice.participants.length}</span>
          )}
        </button>
      ) : (
        <button type="button" aria-expanded={expanded} aria-controls="voice-panel-content"
          onClick={() => setExpanded((open) => !open)} data-testid="voice-panel-toggle"
          className="game-hud-btn inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-xs font-semibold">
          {voice.status === "connected" ? <Radio size={15} className="text-emerald-300" /> : <Headphones size={15} />}
          <span>Voice</span>
          {voice.status === "connected" && <span className="font-mono text-white/60">{voice.participants.length}</span>}
        </button>
      )}
      <div className="pointer-events-none absolute h-px w-px overflow-hidden opacity-0" aria-hidden="true">
        {Object.entries(voice.remoteStreams).map(([peerId, stream]) =>
          <RemoteAudio key={peerId} peerId={peerId} channelId={channelId} stream={stream} muted={voice.speakerMuted}
            register={registerAudio} onPlaybackBlocked={setPlaybackBlocked} />)}
      </div>
      {expanded && <section id="voice-panel-content" aria-label="Voice chat controls"
        className={`absolute ${fab ? "bottom-[4.25rem] left-0" : "right-0 top-11"} z-[70] w-[min(20rem,94vw)] overflow-hidden rounded-2xl border border-amber-200/20 bg-[#07130f]/95 p-3 text-white shadow-2xl backdrop-blur-xl`}
        data-testid="voice-panel-content">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-bold">Room voice</h2>
            <div className={`mt-1 inline-flex items-center gap-1.5 text-xs ${statusTone}`} role="status" aria-live="polite" data-testid="voice-status">
              {voice.status === "connected" ? <Wifi size={13} /> : voice.status === "reconnecting" || voice.status === "failed" ? <WifiOff size={13} /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
              {STATUS_LABEL[voice.status]}
            </div>
          </div>
          <button type="button" onClick={() => setExpanded(false)} aria-label="Close voice chat controls"
            className="rounded-full p-1 text-white/55 hover:bg-white/10 hover:text-white"><X size={15} /></button>
        </header>

        {voice.message && <p className="mt-2 rounded-lg border border-amber-200/15 bg-amber-200/5 px-2.5 py-2 text-xs leading-relaxed text-amber-100/85" data-testid="voice-message">{voice.message}</p>}

        {!inVoice ? (
          <button type="button" onClick={voice.join} disabled={!eligible || !voice.connected}
            className="mt-3 w-full rounded-xl bg-amber-300 px-3 py-2.5 text-sm font-bold text-slate-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-45"
            data-testid={voice.status === "reconnecting" ? "voice-rejoin" : "voice-join"}>
            {voice.status === "reconnecting" ? "Rejoin voice" : "Join voice"}
          </button>
        ) : voice.status === "connected" ? (
          <>
            <div className="mt-3 grid grid-cols-3 gap-1.5">
              <button type="button" onClick={voice.toggleMic} aria-pressed={!voice.micMuted}
                aria-label={voice.micMuted ? "Enable microphone" : "Mute microphone"}
                className={`inline-flex min-h-10 items-center justify-center gap-1 rounded-lg border px-2 text-[11px] font-semibold ${voice.micMuted ? "border-rose-200/20 bg-rose-300/10 text-rose-100" : "border-emerald-200/20 bg-emerald-300/10 text-emerald-100"}`}
                data-testid="voice-microphone-toggle">
                {voice.micMuted ? <MicOff size={14} /> : <Mic size={14} />}{voice.micMuted ? "Mic off" : "Mic on"}
              </button>
              <button type="button" onClick={toggleSpeaker} aria-pressed={!voice.speakerMuted}
                aria-label={voice.speakerMuted || playbackBlocked ? "Enable voice speakers" : "Mute voice speakers"}
                className="inline-flex min-h-10 items-center justify-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 text-[11px] font-semibold text-white/85"
                data-testid="voice-speaker-toggle">
                {voice.speakerMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}{voice.speakerMuted ? "Sound off" : playbackBlocked ? "Enable sound" : "Sound on"}
              </button>
              <button type="button" onClick={voice.leave}
                className="inline-flex min-h-10 items-center justify-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 text-[11px] font-semibold text-white/85 hover:border-rose-200/25 hover:text-rose-100"
                data-testid="voice-leave">Leave</button>
            </div>
            <div className="mt-3 flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.12em] text-white/45">
              <span>In this voice channel</span><span data-testid="voice-participant-count">{voice.participants.length}</span>
            </div>
            <ul className="mt-2 max-h-44 space-y-1 overflow-y-auto pr-1" data-testid="voice-participants">
              {voice.participants.map((participant) => {
                const state = voice.peerStates[participant.peer_id];
                return <li key={participant.peer_id} data-testid={`voice-participant-${participant.peer_id}`}
                  className={`flex min-w-0 items-center gap-2 rounded-xl border px-2 py-1.5 ${participant.speaking ? "border-emerald-300/40 bg-emerald-300/10" : "border-white/5 bg-white/[0.035]"}`}>
                  <PlayerAvatar user={{ ...participant, username: participant.display_name }} size={30}
                    className={participant.speaking ? "rounded-full ring-2 ring-emerald-300" : ""} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold text-white/90">{participant.display_name}{participant.self ? " · You" : ""}</div>
                    <div className="text-[10px] text-white/45">{participant.role === "spectator" ? "Spectator" : "Player"} · {participant.self ? "You" : state === "connected" ? "Connected" : state === "failed" || state === "disconnected" ? "Connection issue" : "Connecting"}</div>
                  </div>
                  <span className={participant.speaking ? "text-emerald-200" : "text-white/40"} title={participant.speaking ? "Speaking" : participant.muted ? "Microphone muted" : "Microphone ready"}>
                    {participant.muted ? <MicOff size={14} /> : participant.speaking ? <Radio size={14} /> : <Mic size={14} />}
                  </span>
                </li>;
              })}
            </ul>
            {playbackBlocked && !voice.speakerMuted && <p className="mt-2 text-[11px] text-amber-100/80" data-testid="voice-playback-blocked">Tap Enable sound to allow audio playback.</p>}
          </>
        ) : <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-xs text-white/60">Opening the voice channel…</p>
          <button type="button" onClick={voice.leave} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-semibold text-white/75 hover:border-rose-200/25 hover:text-rose-100" data-testid="voice-cancel">Cancel</button>
        </div>}
      </section>}
    </div>
  );
}
