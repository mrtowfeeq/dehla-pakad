import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  SESSION_REPLACED_EVENT,
  SESSION_REPLACED_MESSAGE,
  isSessionReplacedError,
  notifySessionReplaced,
  resetSessionReplacedNotice,
} from "./sessionReplaced";
import { AuthNotice } from "@/components/auth/AuthNotice";

jest.mock("@clerk/react", () => ({ useAuth: () => ({ getToken: async () => null }) }));
// api.js reads the backend URL at import time.
process.env.REACT_APP_BACKEND_URL = "http://backend.test";
const { errMsg } = require("./api");

global.IS_REACT_ACT_ENVIRONMENT = true;

const replacedError = { response: { status: 401, data: { detail: { code: "session_replaced", message: SESSION_REPLACED_MESSAGE } } } };

beforeEach(() => {
  window.sessionStorage.clear();
  resetSessionReplacedNotice();
});

test("recognizes only the backend's session_replaced 401", () => {
  expect(isSessionReplacedError(replacedError)).toBe(true);
  expect(isSessionReplacedError({ response: { status: 401, data: { detail: "Invalid or expired session" } } })).toBe(false);
  expect(isSessionReplacedError({ response: { status: 403, data: { detail: { code: "session_replaced" } } } })).toBe(false);
  expect(isSessionReplacedError(new Error("network"))).toBe(false);
});

test("error messages read structured and plain details", () => {
  expect(errMsg(replacedError)).toBe(SESSION_REPLACED_MESSAGE);
  expect(errMsg({ response: { data: { detail: "Room is full" } } })).toBe("Room is full");
  expect(errMsg(new Error("Network Error"))).toBe("Network Error");
});

test("notifies once per signed-in session and stores the message for the sign-in page", () => {
  const listener = jest.fn();
  window.addEventListener(SESSION_REPLACED_EVENT, listener);
  notifySessionReplaced(SESSION_REPLACED_MESSAGE);
  notifySessionReplaced(SESSION_REPLACED_MESSAGE); // REST 401 and WebSocket close arrive together
  expect(listener).toHaveBeenCalledTimes(1);
  expect(window.sessionStorage.getItem("dehla.authNotice")).toBe(SESSION_REPLACED_MESSAGE);
  resetSessionReplacedNotice();
  notifySessionReplaced();
  expect(listener).toHaveBeenCalledTimes(2);
  window.removeEventListener(SESSION_REPLACED_EVENT, listener);
});

test("the sign-in page shows the notice once", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  notifySessionReplaced(SESSION_REPLACED_MESSAGE);
  await act(async () => { root.render(<React.StrictMode><AuthNotice /></React.StrictMode>); });
  expect(container.querySelector('[data-testid="auth-notice"]').textContent).toBe(SESSION_REPLACED_MESSAGE);
  expect(window.sessionStorage.getItem("dehla.authNotice")).toBeNull();

  await act(async () => { root.render(<div />); });
  await act(async () => { root.render(<AuthNotice />); });
  expect(container.querySelector('[data-testid="auth-notice"]')).toBeNull();
  act(() => root.unmount());
  container.remove();
});
