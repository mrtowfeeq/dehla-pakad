import React, { act } from "react";
import { createRoot } from "react-dom/client";
import Landing from "./Landing";

jest.mock("react-router-dom", () => {
  const ReactModule = jest.requireActual("react");
  return { Link: ({ to, children, ...props }) => ReactModule.createElement("a", { ...props, href: to }, children) };
});
jest.mock("@/components/PlayingCard", () => ({ PlayingCard: ({ card, testId }) => <span data-testid={testId}>{card}</span> }));
jest.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => <button type="button">theme</button> }));

global.IS_REACT_ACT_ENVIRONMENT = true;

let root;
let container;
const tid = (id) => container.querySelector(`[data-testid="${id}"]`);

beforeEach(async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<Landing />); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

test("every sign-up and log-in button goes to the right page", () => {
  for (const id of ["landing-register-btn", "hero-get-started-btn", "cta-get-started-btn"]) expect(tid(id).getAttribute("href")).toBe("/sign-up");
  for (const id of ["landing-login-link", "hero-login-btn", "cta-login-btn"]) expect(tid(id).getAttribute("href")).toBe("/sign-in");
});

test("the hero table shows all four tens", () => {
  expect([0, 1, 2, 3].map((i) => tid(`hero-card-${i}`).textContent)).toEqual(["10H", "10S", "10D", "10C"]);
});

test("the ways to win list the three round results with their points", () => {
  const text = container.textContent;
  expect(text).toContain("1 ptNormal Win");
  expect(text).toContain("2 ptsKoth");
  expect(text).toContain("3 ptsGrand Slam · 13 Mann");
  expect(text).toContain("picks any suit as trump");
});
