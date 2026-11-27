import { useEffect, useState } from "react";
import { clearAuthNotice, readAuthNotice } from "@/lib/sessionReplaced";

// Shows why this browser was signed out (e.g. the account logged in on another device), once.
export function AuthNotice() {
  const [message] = useState(readAuthNotice);
  useEffect(() => { if (message) clearAuthNotice(); }, [message]);
  if (!message) return null;
  return (
    <div role="alert" data-testid="auth-notice"
      className="mb-4 w-full max-w-sm rounded-xl border border-amber-300/30 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">
      {message}
    </div>
  );
}
