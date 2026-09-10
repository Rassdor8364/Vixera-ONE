/**
 * Praxion on this device. `TauriPraxionTransport` inside the app (loopback
 * through Rust, no CORS), `FetchPraxionTransport` in a browser. Availability
 * is re-probed every 15 s and exposed as a state mark; absence is normal.
 */
import { useEffect, useState } from "react";
import { FetchPraxionTransport, PraxionClient, type PraxionAvailability, type PraxionConnector, type PraxionTransport } from "@vixera/praxion";
import { TauriPraxionTransport } from "../platform/praxion-transport.ts";
import { isTauri } from "../platform/tauri.ts";

export const PRAXION_PROBE_INTERVAL_MS = 15_000;

export function createPraxionClient(baseUrl: string, transport?: PraxionTransport): PraxionClient {
  const t = transport ?? (isTauri() ? new TauriPraxionTransport(baseUrl) : new FetchPraxionTransport(baseUrl));
  return new PraxionClient(t, { cacheMs: PRAXION_PROBE_INTERVAL_MS });
}

export const PRAXION_UNKNOWN: PraxionAvailability = { state: "unavailable", reason: "not_running", detail: "not probed yet" };

/** Polls availability; `invalidate()` before each probe so the cache never hides a state change. */
export function usePraxionAvailability(praxion: PraxionConnector & { invalidate?: () => void }, intervalMs = PRAXION_PROBE_INTERVAL_MS): PraxionAvailability {
  const [availability, setAvailability] = useState<PraxionAvailability>(PRAXION_UNKNOWN);
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      praxion.invalidate?.();
      const next = await praxion.availability().catch<PraxionAvailability>(() => PRAXION_UNKNOWN);
      if (!cancelled) setAvailability((prev) => (sameAvailability(prev, next) ? prev : next));
    };
    void probe();
    const timer = setInterval(() => void probe(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [praxion, intervalMs]);
  return availability;
}

function sameAvailability(a: PraxionAvailability, b: PraxionAvailability): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function praxionLabel(a: PraxionAvailability): string {
  switch (a.state) {
    case "available":
      return `Praxion ${a.appVersion}`;
    case "incompatible":
      return `Praxion incompatible (${a.serverVersion})`;
    case "unavailable":
      return "Praxion absent";
  }
}
