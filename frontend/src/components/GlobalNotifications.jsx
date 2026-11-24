import { useNavigate, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { useApp, useSocketEvent } from "@/context/AppContext";
import { sound } from "@/lib/sound";

export function GlobalNotifications() {
  const navigate = useNavigate();
  const loc = useLocation();
  const { me, refreshMe } = useApp();
  useSocketEvent((m) => {
    if (m.type === "match_cancelled") {
      sound.stopAll();
      sound.ambience(false);
      toast(m.message, { description: `${m.by} exited the match. No points were awarded.`, id: `cancel-${m.game_id}`, duration: 6000 });
      refreshMe();
      navigate("/home", { replace: true });
      return;
    }
    if (m.type === "chat" && m.message.user_id !== me?.user_id) sound.play("chat", { minGap: 400 });
    if (m.type === "invitation") {
      sound.play("room_invite");
      const inv = m.invitation;
      toast(`${inv.from_username} invited you to a private room`, {
        description: `Invite code ${inv.room_code}`,
        duration: 15000,
        action: { label: "Join", onClick: () => navigate(`/join/${inv.room_code}`) },
      });
    } else if (m.type === "friend_request") {
      sound.play("friend_invite");
      toast(`${m.from} sent you a friend request`, { action: { label: "View", onClick: () => navigate("/friends") } });
    } else if (m.type === "friend_accepted") {
      sound.play("success");
      toast.success(`${m.by} accepted your friend request`);
    } else if (m.type === "match_found") {
      sound.play("notify");
      toast.success("Match found! Taking you to the table lobby.");
      navigate(`/room/${m.code}`);
    } else if (m.type === "game_started" && !loc.pathname.startsWith("/game/") && !loc.pathname.startsWith("/room/")) {
      navigate(`/game/${m.game_id}`);
    }
  });
  return null;
}
