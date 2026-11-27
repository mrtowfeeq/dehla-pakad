import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useApp, useSocketEvent } from "./AppContext";

jest.mock("@clerk/react", () => ({ useAuth: () => global.__dehlaAuth }));
jest.mock("@/lib/api", () => ({ useApi: () => global.__dehlaApi, WS_URL: "ws://dehla.test/api/ws" }));

global.IS_REACT_ACT_ENVIRONMENT = true;

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.sent = [];
    this.closeCalls = 0;
    MockWebSocket.instances.push(this);
  }

  send(raw) {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error("WebSocket is not open");
    this.sent.push(JSON.parse(raw));
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  message(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  serverClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  close() {
    this.closeCalls += 1;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

let root;
let container;
let currentApp;
let getToken;
let originalWebSocket;

function AppProbe() {
  currentApp = useApp();
  return null;
}

function EventListener({ handler }) {
  useSocketEvent(handler);
  return null;
}

async function renderApp(listener = null) {
  await act(async () => {
    root.render(
      <AppProvider>
        <AppProbe />
        {listener && <React.StrictMode>{listener}</React.StrictMode>}
      </AppProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitForSocket() {
  await renderApp();
}

beforeEach(() => {
  MockWebSocket.instances = [];
  originalWebSocket = global.WebSocket;
  global.WebSocket = MockWebSocket;
  getToken = jest.fn().mockResolvedValue("session-token");
  global.__dehlaAuth = { isSignedIn: true, getToken };
  global.__dehlaApi = { get: jest.fn().mockResolvedValue({ data: { username: "player" } }) };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  currentApp = null;
});

afterEach(() => {
  if (root) act(() => root.unmount());
  root = null;
  container?.remove();
  jest.useRealTimers();
  delete global.__dehlaAuth;
  delete global.__dehlaApi;
  if (originalWebSocket === undefined) delete global.WebSocket;
  else global.WebSocket = originalWebSocket;
});

test("does not open a second socket while token retrieval is in flight", async () => {
  let resolveToken;
  getToken.mockReturnValue(new Promise((resolve) => { resolveToken = resolve; }));

  await waitForSocket();
  expect(getToken).toHaveBeenCalledTimes(1);
  act(() => {
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("online"));
  });
  expect(getToken).toHaveBeenCalledTimes(1);

  await act(async () => {
    resolveToken("session-token");
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(MockWebSocket.instances).toHaveLength(1);
});

test("does not reconnect while the current socket is CONNECTING", async () => {
  await waitForSocket();
  expect(MockWebSocket.instances).toHaveLength(1);
  expect(MockWebSocket.instances[0].readyState).toBe(MockWebSocket.CONNECTING);

  act(() => {
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("online"));
  });
  expect(MockWebSocket.instances).toHaveLength(1);
});

test("does not guess the route game from hello; reconnect exposes an authenticated socket", async () => {
  const handler = jest.fn();
  await renderApp(<EventListener handler={handler} />);
  const first = MockWebSocket.instances[0];

  act(() => {
    first.open();
    first.message({ type: "hello", active_game_id: "game-1" });
  });
  expect(first.sent).toContainEqual({ type: "auth", token: "session-token" });
  expect(first.sent).not.toContainEqual(expect.objectContaining({ type: "sync_game" }));
  expect(currentApp.connected).toBe(true);
  act(() => window.dispatchEvent(new Event("online")));
  expect(MockWebSocket.instances).toHaveLength(1);

  act(() => first.serverClose());
  expect(currentApp.connected).toBe(false);
  act(() => window.dispatchEvent(new Event("online")));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(MockWebSocket.instances).toHaveLength(2);

  const reconnected = MockWebSocket.instances[1];
  act(() => {
    reconnected.open();
    reconnected.message({ type: "hello", active_game_id: "game-1" });
    reconnected.message({ type: "game_state", game_id: "game-1", state: { seq: 8, hand: ["AS"] } });
  });
  expect(reconnected.sent).not.toContainEqual(expect.objectContaining({ type: "sync_game" }));
  expect(handler).toHaveBeenCalledWith(expect.objectContaining({
    type: "game_state",
    game_id: "game-1",
    state: expect.objectContaining({ seq: 8, hand: ["AS"] }),
  }));
});

test("keeps one event subscription across rerenders and removes it on unmount", async () => {
  const firstHandler = jest.fn();
  const nextHandler = jest.fn();
  await renderApp(<EventListener handler={firstHandler} />);
  const ws = MockWebSocket.instances[0];
  act(() => { ws.open(); ws.message({ type: "hello", active_game_id: null }); });

  await renderApp(<EventListener handler={nextHandler} />);
  act(() => ws.message({ type: "custom_event" }));
  expect(firstHandler).not.toHaveBeenCalledWith({ type: "custom_event" });
  expect(nextHandler).toHaveBeenCalledTimes(1);

  await renderApp();
  act(() => ws.message({ type: "after_unmount" }));
  expect(nextHandler).toHaveBeenCalledTimes(1);
});

test("a medals message from the server updates the lifetime total; a malformed one is ignored", async () => {
  global.__dehlaApi = { get: jest.fn().mockResolvedValue({ data: { username: "player", medals: 10 } }) };
  await waitForSocket();
  const ws = MockWebSocket.instances[0];
  act(() => { ws.open(); ws.message({ type: "hello", active_game_id: null }); });
  expect(currentApp.me.medals).toBe(10);
  act(() => ws.message({ type: "medals", medals: 21, delta: 11, game_id: "g", round: 1 }));
  expect(currentApp.me.medals).toBe(21);
  act(() => ws.message({ type: "medals", medals: "lots" }));
  expect(currentApp.me.medals).toBe(21);
});
test("clears the active socket when the user logs out", async () => {
  await waitForSocket();
  const ws = MockWebSocket.instances[0];
  act(() => { ws.open(); ws.message({ type: "hello", active_game_id: null }); });

  global.__dehlaAuth = { isSignedIn: false, getToken };
  await renderApp();

  expect(ws.closeCalls).toBe(1);
  expect(currentApp.send({ type: "ping" })).toBe(false);
});

test("retries a temporarily suspended account only after its expiry", async () => {
  jest.useFakeTimers();
  await waitForSocket();
  const ws = MockWebSocket.instances[0];
  act(() => { ws.open(); ws.message({ type: "hello", active_game_id: null }); });
  const expiresAt = new Date(Date.now() + 5000).toISOString();

  act(() => ws.message({ type: "account_restricted", message: "Temporary suspension", expires_at: expiresAt }));
  expect(ws.closeCalls).toBe(1);
  expect(currentApp.connected).toBe(false);
  expect(MockWebSocket.instances).toHaveLength(1);

  await act(async () => {
    jest.advanceTimersByTime(5249);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(MockWebSocket.instances).toHaveLength(1);

  await act(async () => {
    jest.advanceTimersByTime(1);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(MockWebSocket.instances).toHaveLength(2);
});

test("does not retry after a permanent account restriction", async () => {
  await waitForSocket();
  const ws = MockWebSocket.instances[0];
  act(() => { ws.open(); ws.message({ type: "hello", active_game_id: null }); });

  act(() => ws.message({ type: "account_restricted", message: "Permanent ban", expires_at: null }));
  act(() => window.dispatchEvent(new Event("online")));
  expect(ws.closeCalls).toBe(1);
  expect(MockWebSocket.instances).toHaveLength(1);
});

test("a session_replaced message signs this browser out and never reconnects", async () => {
  jest.useFakeTimers();
  const signOut = jest.fn().mockResolvedValue(undefined);
  global.__dehlaAuth = { isSignedIn: true, getToken, signOut };
  await waitForSocket();
  const ws = MockWebSocket.instances[0];
  act(() => { ws.open(); ws.message({ type: "hello", active_game_id: "game-1" }); });

  await act(async () => {
    ws.message({ type: "session_replaced", message: "Your account was logged in on another device." });
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(currentApp.connected).toBe(false);
  expect(signOut).toHaveBeenCalledWith({ redirectUrl: "/sign-in" });
  expect(window.sessionStorage.getItem("dehla.authNotice")).toBe("Your account was logged in on another device.");

  await act(async () => {
    window.dispatchEvent(new Event("online"));
    jest.advanceTimersByTime(30000);
    await Promise.resolve();
  });
  expect(MockWebSocket.instances).toHaveLength(1);
  expect(currentApp.send({ type: "ping" })).toBe(false);
  window.sessionStorage.clear();
});

test("a 4409 close from the server stops reconnecting and signs out; other closes still reconnect", async () => {
  jest.useFakeTimers();
  const signOut = jest.fn().mockResolvedValue(undefined);
  global.__dehlaAuth = { isSignedIn: true, getToken, signOut };
  await waitForSocket();
  const first = MockWebSocket.instances[0];
  act(() => { first.open(); first.message({ type: "hello", active_game_id: null }); });

  // An ordinary drop reconnects as before.
  await act(async () => {
    first.readyState = MockWebSocket.CLOSED;
    first.onclose?.({ code: 1006 });
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(MockWebSocket.instances).toHaveLength(2);
  expect(signOut).not.toHaveBeenCalled();

  const second = MockWebSocket.instances[1];
  act(() => { second.open(); second.message({ type: "hello", active_game_id: null }); });
  await act(async () => {
    second.readyState = MockWebSocket.CLOSED;
    second.onclose?.({ code: 4409 });
    jest.advanceTimersByTime(30000);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(MockWebSocket.instances).toHaveLength(2);
  expect(signOut).toHaveBeenCalledTimes(1);
  window.sessionStorage.clear();
});

test("closes the socket and removes reconnect listeners when the provider unmounts", async () => {
  await waitForSocket();
  const ws = MockWebSocket.instances[0];
  act(() => { ws.open(); ws.message({ type: "hello", active_game_id: null }); });
  const tokenCalls = getToken.mock.calls.length;

  act(() => root.unmount());
  root = null;
  expect(ws.closeCalls).toBe(1);
  expect(currentApp.send({ type: "ping" })).toBe(false);

  act(() => window.dispatchEvent(new Event("online")));
  expect(getToken).toHaveBeenCalledTimes(tokenCalls);
  expect(MockWebSocket.instances).toHaveLength(1);
});
