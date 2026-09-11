/**
 * The door has to work for the one person who uses it, so the parts that can
 * silently go wrong are pinned: which Supabase call each mode makes, what a
 * confirmation-required sign-up shows, and that the keep-signed-in choice is
 * actually recorded rather than decorative.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Auth } from "./Auth.tsx";
import { keepSignedIn, setKeepSignedIn } from "../bootstrap/session-preference.ts";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** A stand-in for the bits of supabase.auth this screen touches. */
function fakeClient(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: { method: string; args: unknown }[] = [];
  const auth = {
    signInWithPassword: vi.fn(async (args: unknown) => {
      calls.push({ method: "signInWithPassword", args });
      return { data: {}, error: null };
    }),
    signUp: vi.fn(async (args: unknown) => {
      calls.push({ method: "signUp", args });
      return { data: { session: null, user: { id: "u1" } }, error: null };
    }),
    resetPasswordForEmail: vi.fn(async (args: unknown) => {
      calls.push({ method: "resetPasswordForEmail", args });
      return { data: {}, error: null };
    }),
    ...overrides,
  };
  return { client: { auth } as never, calls, auth };
}

function render(client: never) {
  act(() => root.render(<Auth client={client} defaultEmail={null} />));
}

function text() {
  return host.textContent ?? "";
}

function byText(label: string): HTMLElement {
  const el = [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label);
  if (!el) throw new Error(`no button "${label}" in: ${[...host.querySelectorAll("button")].map((b) => b.textContent).join(" | ")}`);
  return el as HTMLElement;
}

function type(selector: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`no input ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Auth", () => {
  it("signs in and records the keep-signed-in choice", async () => {
    const { client, auth } = fakeClient();
    render(client);
    type('input[type="email"]', "daniel@vixera.ai");
    type('input[type="password"]', "hunter2hunter2");
    await act(async () => {
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: "daniel@vixera.ai", password: "hunter2hunter2" });
    expect(keepSignedIn()).toBe(true);
  });

  it("unchecking keep-signed-in is remembered, so the next launch signs out", async () => {
    const { client } = fakeClient();
    render(client);
    act(() => byText("Keep me signed in").click());
    type('input[type="email"]', "daniel@vixera.ai");
    type('input[type="password"]', "hunter2hunter2");
    await act(async () => {
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(keepSignedIn()).toBe(false);
  });

  it("registers with the name in user metadata and asks for confirmation", async () => {
    const { client, auth } = fakeClient();
    render(client);
    act(() => byText("Create account").click());
    type('input[autocomplete="given-name"]', "Daniel");
    type('input[autocomplete="family-name"]', "Vaszary");
    type('input[type="email"]', "daniel@vixera.ai");
    type('input[type="password"]', "longenoughpassword");
    // the terms control is the only check on the register screen
    act(() => host.querySelector<HTMLElement>(".auth__check")!.click());
    await act(async () => {
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(auth.signUp).toHaveBeenCalledWith({
      email: "daniel@vixera.ai",
      password: "longenoughpassword",
      options: { data: { display_name: "Daniel Vaszary", first_name: "Daniel", last_name: "Vaszary" } },
    });
    // signUp returned no session, so the screen asks for the emailed link
    expect(text()).toContain("Confirm your address");
    expect(text()).toContain("daniel@vixera.ai");
  });

  it("refuses to register without agreeing, and never calls Supabase", async () => {
    const { client, auth } = fakeClient();
    render(client);
    act(() => byText("Create account").click());
    type('input[type="email"]', "daniel@vixera.ai");
    type('input[type="password"]', "longenoughpassword");
    await act(async () => {
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(auth.signUp).not.toHaveBeenCalled();
    expect(text()).toContain("accept the terms");
  });

  it("sends a reset link from the forgot-password mode", async () => {
    const { client, auth } = fakeClient();
    render(client);
    act(() => byText("FORGOT?").click());
    type('input[type="email"]', "daniel@vixera.ai");
    await act(async () => {
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith("daniel@vixera.ai");
    expect(text()).toContain("Reset link sent");
  });

  it("names the way out of the project's email quota instead of echoing the code", async () => {
    const { client } = fakeClient({
      signUp: vi.fn(async () => ({ data: {}, error: new Error("email rate limit exceeded") })),
    });
    render(client);
    act(() => byText("Create account").click());
    type('input[type="email"]', "daniel@vixera.ai");
    type('input[type="password"]', "longenoughpassword");
    act(() => host.querySelector<HTMLElement>(".auth__check")!.click());
    await act(async () => {
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(text()).toContain("turn off email confirmation");
  });

  it("turns Supabase's stock messages into something a person can act on", async () => {
    const { client } = fakeClient({
      signInWithPassword: vi.fn(async () => ({ data: {}, error: new Error("Invalid login credentials") })),
    });
    render(client);
    type('input[type="email"]', "daniel@vixera.ai");
    type('input[type="password"]', "wrong");
    await act(async () => {
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(text()).toContain("do not match an account");
  });
});

describe("session preference", () => {
  it("defaults to keeping the session and round-trips both ways", () => {
    expect(keepSignedIn()).toBe(true);
    setKeepSignedIn(false);
    expect(keepSignedIn()).toBe(false);
    setKeepSignedIn(true);
    expect(keepSignedIn()).toBe(true);
  });
});
