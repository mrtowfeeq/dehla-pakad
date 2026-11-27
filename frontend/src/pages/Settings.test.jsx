import React, { act } from "react";
import { createRoot } from "react-dom/client";
import Settings from "./Settings";

jest.mock("react-router-dom", () => {
  const ReactModule = jest.requireActual("react");
  return { Link: ({ to, children, ...props }) => ReactModule.createElement("a", { ...props, href: to }, children) };
});
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock("next-themes", () => ({ useTheme: () => global.__theme }));
jest.mock("@clerk/react", () => ({ useClerk: () => global.__clerk }));
jest.mock("@/context/AppContext", () => ({ useApp: () => global.__app }));
jest.mock("@/lib/api", () => ({ errMsg: () => "error" }));
jest.mock("@/components/PlayerAvatar", () => ({ PlayerAvatar: () => <span /> }));
jest.mock("@/components/AvatarPicker", () => ({
  AvatarPicker: ({ onColor }) => <button type="button" data-testid="pick-color" onClick={() => onColor("#000000")} />,
}));
jest.mock("@/components/SoundSettings", () => ({ SoundSettings: () => <div data-testid="sound-settings-panel" /> }));

global.IS_REACT_ACT_ENVIRONMENT = true;

let root;
let container;
const tid = (id) => container.querySelector(`[data-testid="${id}"]`);

function type(el, value) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  global.__theme = { resolvedTheme: "dark", setTheme: jest.fn() };
  global.__clerk = { openUserProfile: jest.fn(), signOut: jest.fn() };
  global.__app = {
    me: { username: "firefox", display_name: "", bio: "", email: "fox@example.test", avatar_color: "#ffffff", avatar_icon: "flame", avatar_colors: [], avatar_icons: [] },
    api: { patch: jest.fn().mockResolvedValue({}) },
    refreshMe: jest.fn().mockResolvedValue(),
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

test("save is disabled until something changes, and the preview follows the form", async () => {
  await act(async () => { root.render(<Settings />); });
  expect(tid("settings-save-btn").disabled).toBe(true);
  expect(tid("settings-preview-name").textContent).toBe("firefox");
  await act(async () => { type(tid("settings-display-name-input"), "Fox King"); });
  expect(tid("settings-preview-name").textContent).toBe("Fox King");
  expect(tid("settings-save-btn").disabled).toBe(false);
  expect(tid("settings-unsaved")).not.toBeNull();
  await act(async () => { tid("settings-save-btn").click(); });
  expect(global.__app.api.patch).toHaveBeenCalledWith("/me", expect.objectContaining({ username: "firefox", display_name: "Fox King" }));
  expect(global.__app.refreshMe).toHaveBeenCalled();
});

test("changing the avatar also enables save", async () => {
  await act(async () => { root.render(<Settings />); });
  await act(async () => { tid("pick-color").click(); });
  expect(tid("settings-save-btn").disabled).toBe(false);
});

test("theme, account and sign-out controls", async () => {
  await act(async () => { root.render(<Settings />); });
  expect(tid("theme-option-dark").getAttribute("aria-pressed")).toBe("true");
  await act(async () => { tid("theme-option-light").click(); });
  expect(global.__theme.setTheme).toHaveBeenCalledWith("light");
  expect(tid("settings-account").textContent).toContain("fox@example.test");
  await act(async () => { tid("manage-account-btn").click(); });
  expect(global.__clerk.openUserProfile).toHaveBeenCalled();
  await act(async () => { tid("logout-btn").click(); });
  expect(global.__clerk.signOut).toHaveBeenCalledWith({ redirectUrl: "/" });
  expect(global.__app.api.patch).not.toHaveBeenCalled();
  expect(tid("settings-view-profile").getAttribute("href")).toBe("/profile/firefox");
});
