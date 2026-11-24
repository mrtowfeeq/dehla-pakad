import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Loader2, Swords } from "lucide-react";
import { useApp } from "@/context/AppContext";
import { errMsg } from "@/lib/api";
import { CardBack } from "@/components/PlayingCard";

export default function Matchmaking() {
  const { api } = useApp();
  const navigate = useNavigate();
  const [status, setStatus] = useState({ queued: false, waiting: 0 });
  const queuedRef = useRef(false);

  const apply = (d) => {
    queuedRef.current = d.queued;
    setStatus(d);
    if (d.room_code) navigate(`/room/${d.room_code}`);
  };

  useEffect(() => {
    api.get("/matchmaking/status").then((r) => apply(r.data)).catch(() => {});
    const t = setInterval(() => {
      if (queuedRef.current) api.get("/matchmaking/status").then((r) => apply(r.data)).catch(() => {});
    }, 3000);
    return () => {
      clearInterval(t);
      if (queuedRef.current) api.post("/matchmaking/leave").catch(() => {});
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const join = async () => {
    try { apply((await api.post("/matchmaking/join")).data); } catch (e) { toast.error(errMsg(e)); }
  };
  const leave = async () => {
    await api.post("/matchmaking/leave");
    apply({ queued: false, waiting: Math.max(0, status.waiting - 1) });
  };

  return (
    <div className="max-w-xl mx-auto text-center py-6" data-testid="matchmaking-page">
      <p className="eyebrow">Public matchmaking</p>
      <h1 className="font-display text-4xl mt-3">Find a table</h1>
      <p className="text-muted-foreground mt-3">We seat four players, split them into random teams with partners opposite each other, and start once everyone is ready. Target: 7 points.</p>
      <div className="relative h-48 mt-12 flex items-center justify-center">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`absolute transition-transform duration-700 ${status.queued ? "animate-pulse" : ""}`}
            style={{ transform: `rotate(${(i - 1.5) * 12}deg) translateX(${(i - 1.5) * 34}px)` }}>
            <CardBack size="md" className={i < status.waiting && status.queued ? "!border-amber-300" : "opacity-60"} />
          </div>
        ))}
      </div>
      {status.queued ? (
        <div className="mt-10 space-y-4">
          <div className="inline-flex items-center gap-2 text-primary font-semibold" data-testid="queue-status">
            <Loader2 className="animate-spin" size={18} /> Searching… {status.waiting}/4 players in queue
          </div>
          <div><button className="btn-ghost" onClick={leave} data-testid="leave-queue-btn">Leave queue</button></div>
        </div>
      ) : (
        <button className="btn-gold mt-10 text-base px-8 py-3" onClick={join} data-testid="join-queue-btn">
          <Swords size={18} /> Join queue
        </button>
      )}
    </div>
  );
}
