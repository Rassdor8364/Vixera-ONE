/**
 * Runtime detection and the one `invoke` wrapper every other binding uses.
 *
 * The Field runs in three places: the Tauri WebView on Windows, the Tauri
 * WebView on Android, and a plain browser during Vite development / Vitest.
 * Bindings in this directory must work in all three: inside Tauri they call
 * Rust; outside they fall back to a harmless browser behaviour. No domain
 * logic and no React live here.
 */
import { invoke as tauriInvoke, isTauri as tauriIsTauri } from "@tauri-apps/api/core";
import { platform as osPlatform } from "@tauri-apps/plugin-os";

export type PlatformName = "windows" | "android" | "macos" | "ios" | "ipados" | "linux" | "unknown";

/** True when running inside the Tauri WebView (Windows or Android). */
export function isTauri(): boolean {
  try {
    return tauriIsTauri();
  } catch {
    return false;
  }
}

/** Compile-time platform of the host binary; "unknown" in a browser. */
export function currentPlatform(): PlatformName {
  if (!isTauri()) return "unknown";
  try {
    const name = osPlatform();
    switch (name) {
      case "windows":
      case "android":
      case "macos":
      case "ios":
      case "linux":
        return name;
      default:
        return "unknown";
    }
  } catch {
    return "unknown";
  }
}

export function isAndroid(): boolean {
  return currentPlatform() === "android";
}

/** Thrown when a Rust command is called outside Tauri. */
export class NotInTauriError extends Error {
  constructor(command: string) {
    super(`${command} requires the Vixera One app (not available in the browser)`);
    this.name = "NotInTauriError";
  }
}

/**
 * Invoke a Rust command. Rust command errors arrive as plain strings; they are
 * rethrown as `Error` so callers get a stack and a `.message`.
 */
export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new NotInTauriError(command);
  try {
    return await tauriInvoke<T>(command, args);
  } catch (error) {
    throw toError(error, command);
  }
}

export function toError(error: unknown, context: string): Error {
  if (error instanceof Error) return error;
  const message = typeof error === "string" ? error : JSON.stringify(error);
  return new Error(`${context}: ${message}`);
}
