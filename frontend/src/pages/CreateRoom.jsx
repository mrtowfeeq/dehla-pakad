import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useApp } from "@/context/AppContext";
import { errMsg } from "@/lib/api";
import { TargetPicker } from "@/components/TargetPicker";

export default function CreateRoom() {
  const { api } = useApp();
  const navigate = useNavigate();
  const [target, setTarget] = useState(7);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/rooms", { target });
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
      <button className="btn-gold mt-10 px-8 py-3" onClick={create} disabled={busy} data-testid="create-room-submit-btn">
        {busy ? "Creating…" : "Create room"}
      </button>
    </div>
  );
}
