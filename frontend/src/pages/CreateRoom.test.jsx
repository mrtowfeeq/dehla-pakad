import React, { act } from "react";
import { createRoot } from "react-dom/client";
import CreateRoom from "./CreateRoom";

jest.mock("react-router-dom", () => ({ useNavigate: () => global.__createRoomNavigate }));
jest.mock("@/context/AppContext", () => ({ useApp: () => global.__createRoomContext }));
jest.mock("@/components/TargetPicker", () => ({ TargetPicker: () => <div data-testid="target-picker" /> }));
jest.mock("@/lib/api", () => ({ errMsg: (error) => error?.message || "Request failed" }));
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }));

global.IS_REACT_ACT_ENVIRONMENT = true;

let root;
let container;

beforeEach(() => {
  global.__createRoomNavigate = jest.fn();
  global.__createRoomContext = { api: { post: jest.fn().mockResolvedValue({ data: { code: "ROOM42" } }) } };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete global.__createRoomNavigate;
  delete global.__createRoomContext;
});

test("private room creation sends the selected shared turn duration", async () => {
  await act(async () => root.render(<CreateRoom />));
  const duration = container.querySelector('[data-testid="create-room-turn-duration"]');
  expect(duration.value).toBe("30");
  expect([...duration.options].map((option) => option.value)).toEqual(["15", "20", "30", "45", "60"]);

  await act(async () => {
    duration.value = "45";
    duration.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    container.querySelector('[data-testid="create-room-submit-btn"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });

  expect(global.__createRoomContext.api.post).toHaveBeenCalledWith("/rooms", { target: 7, turn_duration: 45 });
  expect(global.__createRoomNavigate).toHaveBeenCalledWith("/room/ROOM42");
});
