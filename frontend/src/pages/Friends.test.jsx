import React, { act } from "react";
import { createRoot } from "react-dom/client";
import Friends, { lastSeenText } from "./Friends";

jest.mock("react-router-dom", () => {
  const ReactModule = jest.requireActual("react");
  return { Link: ({ to, children, ...props }) => ReactModule.createElement("a", { ...props, href: to }, children) };
});
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }));
jest.mock("@/lib/api", () => ({ errMsg: (e) => e?.message || "Something went wrong" }));
jest.mock("@/context/AppContext", () => ({ useApp: () => global.__app, useSocketEvent: (fn) => { global.__socket = fn; } }));
jest.mock("@/components/PlayerAvatar", () => ({ PlayerAvatar: () => <span /> }));

global.IS_REACT_ACT_ENVIRONMENT = true;

const user = (name, extra = {}) => ({
  user_id: `id-${name}`, username: name, display_name: name, online: false,
  stats: { wins: 4 }, progression: { level: 2 }, last_seen: new Date(Date.now() - 3 * 3600 * 1000).toISOString(), ...extra,
});

let root;
let container;

function setup({ friends = [], incoming = [], outgoing = [], search = [] } = {}) {
  global.__app = {
    api: {
      get: jest.fn((url) => Promise.resolve({
        data: url === "/friends" ? friends : url === "/friends/requests" ? { incoming, outgoing } : search,
      })),
      post: jest.fn().mockResolvedValue({ data: {} }),
      delete: jest.fn().mockResolvedValue({ data: {} }),
    },
  };
}

async function render() {
  await act(async () => { root.render(<Friends />); });
  await act(async () => { await Promise.resolve(); });
}

const q = (id) => container.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
});

test("empty state offers a way to find players", async () => {
  setup();
  await render();
  expect(q("friends-empty").textContent).toContain("No friends yet");
  expect(q("friends-summary").textContent).toContain("0Friends");
  await act(async () => { q("friends-empty-search").click(); });
  expect(document.activeElement).toBe(q("friend-search-input"));
});

test("friends are grouped by presence with level, wins and last seen; presence updates live", async () => {
  setup({ friends: [user("alice", { online: true }), user("bob")], incoming: [{ id: "r1", user: user("carol") }] });
  await render();
  expect(q("friends-online").textContent).toContain("alice");
  expect(q("friends-offline").textContent).toContain("bob");
  expect(q("friend-row-bob").textContent).toContain("Seen 3h ago");
  expect(q("friend-row-alice").textContent).toContain("Lv 2");
  expect(q("friend-row-alice").textContent).toContain("4 wins");
  expect(q("friends-summary").textContent).toBe("2Friends1Online1Requests");

  await act(async () => { global.__socket({ type: "presence", user_id: "id-bob", online: true }); });
  expect(q("friends-offline")).toBeNull();
  expect(q("friends-online").textContent).toContain("bob");
});

test("requests can be accepted and declined, friends removed", async () => {
  setup({ friends: [user("bob")], incoming: [{ id: "r1", user: user("carol") }], outgoing: [{ id: "r2", user: user("dave") }] });
  await render();
  expect(q("outgoing-request-dave").textContent).toContain("Pending");
  await act(async () => { q("accept-request-carol").click(); });
  expect(global.__app.api.post).toHaveBeenCalledWith("/friends/requests/r1/accept");
  await act(async () => { q("decline-request-carol").click(); });
  expect(global.__app.api.post).toHaveBeenCalledWith("/friends/requests/r1/decline");
  await act(async () => { q("remove-friend-bob").click(); });
  expect(global.__app.api.delete).toHaveBeenCalledWith("/friends/id-bob");
});

test("search shows friend, sent and add states", async () => {
  jest.useFakeTimers();
  setup({
    friends: [user("bob")], outgoing: [{ id: "r2", user: user("dave") }],
    search: [user("bob"), user("dave"), user("erin")],
  });
  await render();
  const input = q("friend-search-input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "e");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { jest.advanceTimersByTime(300); await Promise.resolve(); });
  expect(q("search-result-bob").textContent).toContain("Friend");
  expect(q("search-result-dave").textContent).toContain("Sent");
  await act(async () => { q("add-friend-erin").click(); });
  expect(global.__app.api.post).toHaveBeenCalledWith("/friends/requests", { username: "erin" });
});

test("last seen text is relative and never invents a time", () => {
  const now = Date.parse("2026-11-26T12:00:00Z");
  expect(lastSeenText("2026-11-26T11:59:40Z", now)).toBe("Seen just now");
  expect(lastSeenText("2026-11-26T11:15:00Z", now)).toBe("Seen 45m ago");
  expect(lastSeenText("2026-11-24T12:00:00Z", now)).toBe("Seen 2d ago");
  expect(lastSeenText(null, now)).toBe("Offline");
});

test("every friend card shows lifetime medals and the medal table ranks you among your friends", async () => {
  setup({ friends: [user("asha", { medals: 320, online: true }), user("ravi", { medals: 45 }), user("zoya")] });
  global.__app.me = { user_id: "id-me", username: "me", medals: 120 };
  await render();
  expect(q("friend-row-asha-medals").textContent).toBe("320");
  expect(q("friend-row-ravi-medals").textContent).toBe("45");
  expect(q("friend-row-zoya-medals").textContent).toBe("0");
  const rows = [1, 2, 3, 4].map((n) => q(`friends-medal-row-${n}`).textContent);
  expect(rows).toEqual(["1asha320", "2You120", "3ravi45", "4zoya0"]);
  expect(q("friends-medal-row-2").className).toContain("border-orange-200");
  expect(q("friends-medal-panel").querySelector('a[href="/leaderboard?board=medals"]')).not.toBeNull();
});

test("search results show medals too, and the medal table is hidden without friends", async () => {
  jest.useFakeTimers();
  setup({ search: [user("kiran", { medals: 7 })] });
  global.__app.me = { user_id: "id-me", username: "me", medals: 0 };
  await render();
  expect(q("friends-medal-panel")).toBeNull();
  await act(async () => {
    const input = q("friend-search-input");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "kir");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { jest.advanceTimersByTime(300); });
  await act(async () => { await Promise.resolve(); });
  expect(q("search-result-kiran-medals").textContent).toBe("7");
});