import { useState } from "react";
import { UserButton } from "@clerk/react";
import { toast } from "sonner";
import { useApp } from "@/context/AppContext";
import { errMsg } from "@/lib/api";
import { AvatarPicker } from "@/components/AvatarPicker";

export function Onboarding() {
  const { api, me, refreshMe } = useApp();
  const [username, setUsername] = useState("");
  const [color, setColor] = useState(me.avatar_color);
  const [icon, setIcon] = useState(me.avatar_icon);
  const [busy, setBusy] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.patch("/me", { username, avatar_color: color, avatar_icon: icon });
      await refreshMe();
      toast.success("Welcome to the table!");
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen felt grain relative flex items-center justify-center p-4">
      <div className="absolute top-4 right-4"><UserButton /></div>
      <form onSubmit={save} className="relative z-10 panel w-full max-w-md p-8 rise" data-testid="onboarding-form">
        <p className="eyebrow">One last step</p>
        <h1 className="font-display text-3xl mt-2">Choose your table name</h1>
        <p className="text-sm text-muted-foreground mt-2">Other players will see this name and avatar.</p>
        <label className="block mt-6 text-sm font-semibold">Username</label>
        <input data-testid="onboarding-username-input" value={username} onChange={(e) => setUsername(e.target.value)}
          placeholder="e.g. ace_of_tens" maxLength={20}
          className="mt-2 w-full rounded-xl bg-background border border-input px-4 py-3 outline-none focus:ring-2 focus:ring-ring" />
        <p className="text-xs text-muted-foreground mt-1">3–20 letters, numbers or underscore.</p>
        <div className="mt-6">
          <AvatarPicker me={me} color={color} icon={icon} onColor={setColor} onIcon={setIcon} username={username} />
        </div>
        <button className="btn-gold w-full mt-8" disabled={busy || username.length < 3} data-testid="onboarding-submit-btn">
          {busy ? "Saving…" : "Take my seat"}
        </button>
      </form>
    </div>
  );
}
