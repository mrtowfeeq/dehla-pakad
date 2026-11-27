import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { AuthPage } from "./AuthPage";

jest.mock("react-router-dom", () => {
  const ReactModule = jest.requireActual("react");
  return { Link: ({ to, children, ...props }) => ReactModule.createElement("a", { ...props, href: to }, children) };
});
jest.mock("@/components/PlayingCard", () => ({ PlayingCard: ({ card }) => <span data-card={card} /> }));
jest.mock("@/components/auth/AuthNotice", () => ({ AuthNotice: () => <div data-testid="auth-notice" /> }));

global.IS_REACT_ACT_ENVIRONMENT = true;

let root;
let container;

beforeEach(async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<AuthPage><form data-testid="clerk-form" /></AuthPage>); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

test("frames the sign-in form with the notice, the brand linking home and the four tens", () => {
  const q = (sel) => container.querySelector(sel);
  expect(q('[data-testid="clerk-form"]')).not.toBeNull();
  expect(q('[data-testid="auth-notice"]')).not.toBeNull();
  // Desktop showcase and phone header each have the brand; both link home.
  const brands = [...container.querySelectorAll('[data-testid="auth-brand"]')];
  expect(brands).toHaveLength(2);
  brands.forEach((b) => expect(b.getAttribute("href")).toBe("/"));
  expect(q('[data-testid="auth-showcase"]').className).toContain("lg:flex");
  expect(q('[data-testid="auth-mobile-brand"]').className).toContain("lg:hidden");
  expect([...q('[data-testid="auth-showcase"]').querySelectorAll("[data-card]")].map((c) => c.dataset.card)).toEqual(["10H", "10S", "10D", "10C"]);
  expect(q('[data-testid="auth-alt"]')).toBeNull();
});

test("shows a link to switch between sign-in and sign-up when given one", async () => {
  await act(async () => {
    root.render(<AuthPage alt={{ text: "New here?", label: "Create a free account", to: "/sign-up" }}><form /></AuthPage>);
  });
  expect(container.querySelector('[data-testid="auth-alt"]').textContent).toBe("New here? Create a free account");
  expect(container.querySelector('[data-testid="auth-alt-link"]').getAttribute("href")).toBe("/sign-up");
});
