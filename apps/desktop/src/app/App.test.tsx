/**
 * Smoke render of the Field in dev-fixture mode: NOW shows the mock world
 * (Eric's invoice) and One Command "Find Eric" produces a person result.
 * No testing-library: react-dom/client + act.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DEV_USER_ID } from "@vixera/domain";
import { FetchPraxionTransport, PRAXION_DEFAULT_BASE_URL, PraxionClient } from "@vixera/praxion";
import { MOCK_NOW } from "@vixera/sync/testing";
import { App } from "./App.tsx";
import { createDevWorld } from "../bootstrap/dev-fixtures.ts";
import { createShell } from "../bootstrap/runtime.ts";
import { parseConfig } from "../bootstrap/config.ts";
import { isTauri } from "../platform/tauri.ts";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function flush(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out; text was: ${container?.textContent?.slice(0, 400)}`);
    await flush();
  }
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("<App/> in dev-fixture mode", () => {
  it("renders NOW from the mock world and answers One Command", async () => {
    expect(isTauri()).toBe(false);
    const config = parseConfig({ VITE_VIXERA_DEV_FIXTURES: "true", VITE_DEV_USER_ID: DEV_USER_ID });
    expect(config.mode).toBe("dev-fixtures");
    const praxion = new PraxionClient(new FetchPraxionTransport(PRAXION_DEFAULT_BASE_URL, async () => { throw new Error("no praxion"); }), { cacheMs: 60_000 });
    const devWorld = await createDevWorld(config.devUserId, { now: () => new Date(MOCK_NOW) });
    const shell = await createShell(config, { praxion, devWorld, device: { deviceId: "11111111-1111-4111-8111-111111111111", platform: "unknown", name: "Test", createdAt: MOCK_NOW.toISOString() } });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<App shell={shell} />);
    });

    await waitFor(() => (container?.textContent ?? "").includes("Invoice #0231"));
    const text = container.textContent ?? "";
    expect(text).toContain("Now");
    expect(text).toMatch(/Needs you|Changed|Can wait/);
    expect(text).toContain("On this device");
    expect(container.querySelector(".areas")).not.toBeNull();
    expect(container.querySelector("aside, .sidebar")).toBeNull();

    const input = container.querySelector<HTMLInputElement>('input[aria-label="One Command"]');
    expect(input).not.toBeNull();
    await act(async () => setInput(input as HTMLInputElement, "Find Eric"));
    await act(async () => {
      input?.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => (container?.querySelector(".command__result")?.textContent ?? "").includes("Eric Lindqvist"));
    const result = container.querySelector<HTMLButtonElement>(".command__result");
    await act(async () => result?.click());
    await waitFor(() => (container?.querySelector(".context-line__area")?.textContent ?? "") === "People");
    await waitFor(() => (container?.querySelector(".context-line__focus")?.textContent ?? "").includes("Eric Lindqvist"));
    await waitFor(() => (container?.textContent ?? "").includes("Identities"));
  });
});
