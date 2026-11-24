import { useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { useApp } from "@/context/AppContext";
import { errMsg } from "@/lib/api";

export default function JoinRoom() {
  const { code } = useParams();
  const { api } = useApp();
  const navigate = useNavigate();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    api.post(`/rooms/${code}/join`)
      .then((r) => navigate(`/room/${r.data.code}`, { replace: true }))
      .catch((e) => { toast.error(errMsg(e)); navigate("/home", { replace: true }); });
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="text-center text-muted-foreground py-20" data-testid="joining-room">Joining room {code}…</div>;
}
