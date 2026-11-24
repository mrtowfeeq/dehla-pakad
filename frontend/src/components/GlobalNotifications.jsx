import { useNavigate, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { useSocketEvent } from "@/context/AppContext";

export function GlobalNotifications() {
  const navigate = useNavigate();
  const loc = useLocation();
  useSocketEvent((m) => {
    if (m.type === "invitation") {
      const inv = m.invitation;
      toast(`${inv.from_username} invited you to a private room`, {
        description: `Invite code ${inv.room_code}`,
        duration: 15000,
        action: { label: "Join", onClick: () => navigate(`/join/${inv.room_code}`) },
      });
    } else if (m.type === "friend_request") {
      toast(`${m.from} sent you a friend request`, { action: { label: "View", onClick: () => navigate("/friends") } });
    } else if (m.type === "friend_accepted") {
      toast.success(`${m.by} accepted your friend request`);
    } else if (m.type === "match_found") {
      toast.success("Match found! Taking you to the table lobby.");
      navigate(`/room/${m.code}`);
    } else if (m.type === "game_started" && !loc.pathname.startsWith("/game/")) {
      navigate(`/game/${m.game_id}`);
    }
  });
  return null;
}
