import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ChatPanel, PrivateLobbyChatPanel } from "./Chat";

jest.mock("@/context/AppContext", () => ({
  useApp: () => global.__chatTestContext,
  useSocketEvent: (handler) => { global.__chatTestSocketHandler = handler; },
}));

global.IS_REACT_ACT_ENVIRONMENT = true;

let root;
let container;
let api;
let send;

async function render(node) {
  await act(async () => {
    root.render(node);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setTextareaValue(textarea, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView ??= jest.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api = { get: jest.fn().mockResolvedValue({ data: [] }) };
  send = jest.fn(() => true);
  global.__chatTestContext = { api, send, me: { user_id: "player-1" }, connected: false };
  global.__chatTestSocketHandler = null;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete global.__chatTestContext;
  delete global.__chatTestSocketHandler;
});

test("private lobby chat renders sender, timestamp, and room-scoped messages", async () => {
  const message = {
    id: "msg-1", room_code: "ROOM1", channel: "private_lobby", user_id: "player-2",
    username: "Riya", text: "Ready to play?", ts: "2026-02-01T12:30:00+00:00",
  };
  api.get.mockResolvedValue({ data: [message] });
  await render(<React.StrictMode><PrivateLobbyChatPanel roomCode="ROOM1" /></React.StrictMode>);

  expect(api.get).toHaveBeenCalledWith("/rooms/ROOM1/lobby-chat");
  expect(container.textContent).toContain("Riya");
  expect(container.textContent).toContain("Ready to play?");
  expect(container.querySelector("time").getAttribute("dateTime")).toBe(message.ts);

  await act(async () => global.__chatTestSocketHandler({
    type: "private_lobby_chat_message",
    message: { ...message, id: "msg-2", room_code: "ROOM2", text: "wrong room" },
  }));
  expect(container.textContent).not.toContain("wrong room");
});

test("Enter sends a message and Shift+Enter leaves the textarea available for a newline", async () => {
  await render(<PrivateLobbyChatPanel roomCode="ROOM1" />);
  const textarea = container.querySelector('[data-testid="private-lobby-chat-input"]');
  act(() => setTextareaValue(textarea, "first line\nsecond line"));

  let shiftEnter;
  act(() => {
    shiftEnter = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
    textarea.dispatchEvent(shiftEnter);
  });
  expect(shiftEnter.defaultPrevented).toBe(false);
  expect(send).not.toHaveBeenCalled();

  act(() => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  expect(send).toHaveBeenCalledWith({
    type: "private_lobby_chat", room_code: "ROOM1", text: "first line\nsecond line",
  });
  expect(textarea.value).toBe("");
});

test("reloads private lobby history after reconnect without changing chat channels", async () => {
  await render(<PrivateLobbyChatPanel roomCode="ROOM1" />);
  expect(api.get).toHaveBeenCalledTimes(1);

  global.__chatTestContext.connected = true;
  await render(<PrivateLobbyChatPanel roomCode="ROOM1" />);
  expect(api.get).toHaveBeenCalledTimes(2);

  await render(<ChatPanel roomCode="ROOM1" />);
  expect(api.get).toHaveBeenLastCalledWith("/rooms/ROOM1/chat");
});

test("existing public and in-game chat continues to use the existing chat event", async () => {
  await render(<ChatPanel roomCode="ROOM1" />);
  act(() => global.__chatTestSocketHandler({
    type: "chat",
    message: { id: "old-1", room_code: "ROOM1", user_id: "player-2", username: "Aman", text: "Hello" },
  }));
  expect(container.textContent).toContain("Hello");

  const input = container.querySelector('[data-testid="table-chat-input"]');
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Still here");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    container.querySelector('[data-testid="table-chat-send-btn"]').click();
    await Promise.resolve();
  });
  expect(send).toHaveBeenCalledWith({ type: "chat", room_code: "ROOM1", text: "Still here" });
});
