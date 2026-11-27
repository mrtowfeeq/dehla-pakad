import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { TurnTimer } from "./TurnTimer";

global.IS_REACT_ACT_ENVIRONMENT = true;

let root;
let container;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-11-25T12:00:00.000Z"));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
});

test("timer counts down from the server deadline and changes severity near expiry", async () => {
  await act(async () => root.render(
    <TurnTimer deadline="2026-11-25T12:00:15.000Z" duration={15} />,
  ));
  expect(container.querySelector('[data-testid="turn-timer-seconds"]').textContent).toBe("15s");
  expect(container.querySelector('[data-testid="turn-timer"]').getAttribute("data-severity")).toBe("normal");

  act(() => jest.advanceTimersByTime(5000));
  expect(container.querySelector('[data-testid="turn-timer-seconds"]').textContent).toBe("10s");
  expect(container.querySelector('[data-testid="turn-timer"]').getAttribute("data-severity")).toBe("warning");

  act(() => jest.advanceTimersByTime(5000));
  expect(container.querySelector('[data-testid="turn-timer-seconds"]').textContent).toBe("5s");
  expect(container.querySelector('[data-testid="turn-timer"]').getAttribute("data-severity")).toBe("critical");
  expect(container.querySelector('[data-testid="turn-timer-progress"]').style.width).toBe("33.33333333333333%");

  act(() => jest.advanceTimersByTime(5000));
  expect(container.querySelector('[data-testid="turn-timer-seconds"]').textContent).toBe("0s");
  expect(container.querySelector('[data-testid="turn-timer-progress"]').style.width).toBe("0%");
});

test("client countdown compensates for the server clock offset after synchronization", async () => {
  await act(async () => root.render(
    <TurnTimer deadline="2026-11-25T12:00:20.000Z" duration={20} serverOffsetMs={3000} />,
  ));
  expect(container.querySelector('[data-testid="turn-timer-seconds"]').textContent).toBe("17s");
  expect(container.querySelector('[role="progressbar"]').getAttribute("aria-valuemax")).toBe("20");
});

test("grace timer shows the timeout warning and counts down from the authoritative grace deadline", async () => {
  await act(async () => root.render(
    <TurnTimer deadline="2026-11-25T12:00:00.000Z" phase="grace"
      graceDeadline="2026-11-25T12:00:05.000Z" duration={15} />,
  ));

  expect(container.querySelector('[data-testid="turn-timer"]').getAttribute("data-phase")).toBe("grace");
  expect(container.querySelector('[data-testid="turn-timer-warning"]').textContent).toBe("OUT OF TIME · AUTO-PLAY");
  expect(container.querySelector('[data-testid="turn-timer-seconds"]').textContent).toBe("5s");
  expect(container.querySelector('[role="progressbar"]').getAttribute("aria-valuemax")).toBe("5");

  act(() => jest.advanceTimersByTime(3000));
  expect(container.querySelector('[data-testid="turn-timer-seconds"]').textContent).toBe("2s");
  expect(container.querySelector('[data-testid="turn-timer"]').getAttribute("data-severity")).toBe("critical");
  expect(container.querySelector('[data-testid="turn-timer"]').getAttribute("aria-live")).toBe("assertive");
});

test("the badge is centred on the panel's top border by default and beside the panel with side placement", async () => {
  await act(async () => root.render(<TurnTimer deadline="2026-11-25T12:00:15.000Z" duration={15} />));
  const centred = container.querySelector('[data-testid="turn-timer"]').className;
  expect(centred).toContain("-top-3.5");
  expect(centred).toContain("left-1/2");
  expect(centred).toContain("-translate-x-1/2");
  await act(async () => root.render(<TurnTimer deadline="2026-11-25T12:00:15.000Z" duration={15} placement="side" />));
  const badge = container.querySelector('[data-testid="turn-timer"]');
  expect(badge.className).toContain("left-full");
  expect(badge.className).not.toContain("-top-3");
});

test("timer stays hidden when the backend has no active deadline", async () => {
  await act(async () => root.render(<TurnTimer deadline={null} duration={30} />));
  expect(container.querySelector('[data-testid="turn-timer"]')).toBeNull();
});
