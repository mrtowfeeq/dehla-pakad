import { useEffect } from "react";
import { sound } from "@/lib/sound";
import { useApp } from "@/context/AppContext";

// Unlocks audio on the first gesture, binds prefs to the signed-in player, and adds a soft click to buttons.
export function SoundBridge() {
  const { me } = useApp();
  useEffect(() => { if (me?.user_id) sound.setUser(me.user_id); }, [me?.user_id]);
  useEffect(() => {
    const unlock = () => sound.unlock();
    const click = (e) => {
      const el = e.target.closest?.("button, [role=button], [role=menuitem], a[href]");
      if (!el || el.closest("[data-sound=none]") || el.disabled) return;
      sound.play("click", { gain: 0.55, minGap: 60 });
    };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    window.addEventListener("touchend", unlock, { passive: true });
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("touchend", unlock);
      document.removeEventListener("click", click, true);
    };
  }, []);
  return null;
}
