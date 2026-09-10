/**
 * Device identity as persisted by Rust (`device.json` in the app data dir).
 * The id is a random UUID v4 created on first run; it is never derived from the
 * hostname or the OS account. In a browser a per-origin fallback identity is kept
 * in localStorage so development works without Tauri.
 */
import { invoke, isTauri, type PlatformName } from "./tauri.ts";

export interface DeviceIdentity {
  readonly deviceId: string;
  readonly platform: PlatformName;
  readonly name: string;
  /** RFC 3339 UTC timestamp. */
  readonly createdAt: string;
}

const BROWSER_KEY = "vixera.device";

let cached: Promise<DeviceIdentity> | undefined;

export function getDeviceIdentity(): Promise<DeviceIdentity> {
  cached ??= isTauri() ? invoke<DeviceIdentity>("device_identity") : Promise.resolve(browserIdentity());
  return cached;
}

/** Test hook: forget the cached identity. */
export function resetDeviceIdentityCache(): void {
  cached = undefined;
}

function browserIdentity(): DeviceIdentity {
  try {
    const raw = globalThis.localStorage?.getItem(BROWSER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DeviceIdentity>;
      if (typeof parsed.deviceId === "string" && typeof parsed.createdAt === "string") {
        return { deviceId: parsed.deviceId, platform: "unknown", name: parsed.name ?? "Browser", createdAt: parsed.createdAt };
      }
    }
  } catch {
    // localStorage unavailable or unreadable: fall through to a fresh identity.
  }
  const identity: DeviceIdentity = {
    deviceId: crypto.randomUUID(),
    platform: "unknown",
    name: "Browser",
    createdAt: new Date().toISOString(),
  };
  try {
    globalThis.localStorage?.setItem(BROWSER_KEY, JSON.stringify(identity));
  } catch {
    // Best effort only.
  }
  return identity;
}
