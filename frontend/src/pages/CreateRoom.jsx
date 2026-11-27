import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useApp } from "@/context/AppContext";
import { errMsg } from "@/lib/api";
import { TargetPicker } from "@/components/TargetPicker";

const TURN_DURATIONS = [15, 20, 30, 45, 60];

export default function CreateRoom() {
  const { api } = useApp();
  const navigate = useNavigate();
  const [target, setTarget] = useState(7);
  const [turnDuration, setTurnDuration] = useState(30);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/rooms", { target, turn_duration: turnDuration });
      navigate(`/room/${data.code}`);
    } catch (e) { toast.error(errMsg(e)); setBusy(false); }
  };

  return (
    <div className="max-w-lg" data-testid="create-room-page">
      <p className="eyebrow">Private room</p>
      <h1 className="font-display text-4xl mt-3">Host a table</h1>
      <p className="text-muted-foreground mt-3">You'll get an invite code to share. In the lobby you can arrange seats and teams, choose the dealer and start when all four are ready.</p>
      <div className="mt-10">
        <div className="font-semibold mb-3">Match target</div>
        <TargetPicker value={target} onChange={setTarget} />
      </div>
      <div className="mt-6">
        <label htmlFor="room-turn-duration" className="mb-2 block font-semibold">Turn duration</label>
        <select id="room-turn-duration" data-testid="create-room-turn-duration" value={turnDuration}
          onChange={(event) => setTurnDuration(Number(event.target.value))}
          className="w-full rounded-xl border border-input bg-background px-4 py-3 outline-none focus:ring-2 focus:ring-ring">
          {TURN_DURATIONS.map((seconds) => <option key={seconds} value={seconds}>{seconds} seconds</option>)}
        </select>
        <p className="mt-2 text-sm text-muted-foreground">All players will share the same server-timed turn deadline.</p>
      </div>
      <button className="btn-gold mt-10 px-8 py-3" onClick={create} disabled={busy} data-testid="create-room-submit-btn">
        {busy ? "Creating…" : "Create room"}
      </button>
    </div>
  );
}
