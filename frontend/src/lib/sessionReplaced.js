// The backend enforces one active session per account. When a newer login replaces this browser's
// session, REST calls answer 401 {detail: {code: "session_replaced"}} and the WebSocket receives
// {type: "session_replaced"} and closes with code 4409. This module turns either signal into one event.

export const SESSION_REPLACED_CODE = "session_replaced";
export const SESSION_REPLACED_CLOSE = 4409;
export const SESSION_REPLACED_MESSAGE = "Your account was logged in on another device.";
export const SESSION_REPLACED_EVENT = "dehla:session-replaced";
const NOTICE_KEY = "dehla.authNotice";

export function isSessionReplacedError(error) {
  const detail = error?.response?.data?.detail;
  return error?.response?.status === 401 && detail?.code === SESSION_REPLACED_CODE;
}

let notified = false;

export function notifySessionReplaced(message = SESSION_REPLACED_MESSAGE) {
  try { window.sessionStorage.setItem(NOTICE_KEY, message || SESSION_REPLACED_MESSAGE); } catch { /* storage may be blocked */ }
  if (notified) return;
  notified = true;
  window.dispatchEvent(new CustomEvent(SESSION_REPLACED_EVENT, { detail: { message } }));
}

// A fresh sign-in starts a new session; allow the next replacement to be reported again.
export function resetSessionReplacedNotice() {
  notified = false;
}

export function readAuthNotice() {
  try { return window.sessionStorage.getItem(NOTICE_KEY); } catch { return null; }
}

export function clearAuthNotice() {
  try { window.sessionStorage.removeItem(NOTICE_KEY); } catch { /* storage may be blocked */ }
}
