jest.mock("@clerk/react", () => ({ useAuth: () => ({ getToken: async () => null }) }));
jest.mock("@/lib/sessionReplaced", () => ({ isSessionReplacedError: () => false, notifySessionReplaced: () => {} }));

const { resolveBackendUrl } = require("./api");

test("uses the configured backend address, without a trailing slash", () => {
  expect(resolveBackendUrl("https://dehlapakad.tech/", "https://other.example")).toBe("https://dehlapakad.tech");
  expect(resolveBackendUrl(" http://localhost:8000 ", "http://localhost:3000")).toBe("http://localhost:8000");
});

test("falls back to the page's own origin when no address is configured (same-domain production)", () => {
  expect(resolveBackendUrl(undefined, "https://dehlapakad.tech")).toBe("https://dehlapakad.tech");
  expect(resolveBackendUrl("", "https://dehlapakad.tech/")).toBe("https://dehlapakad.tech");
});

test("the WebSocket address follows the backend address (https becomes wss)", () => {
  const backend = resolveBackendUrl(undefined, "https://dehlapakad.tech");
  expect(`${backend.replace(/^http/, "ws")}/api/ws`).toBe("wss://dehlapakad.tech/api/ws");
});
