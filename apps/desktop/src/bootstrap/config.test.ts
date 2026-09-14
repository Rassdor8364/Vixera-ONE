import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "./config.ts";

describe("parseConfig", () => {
  it("refuses dev fixtures in a production build, allows them in development", () => {
    expect(() => parseConfig({ VITE_VIXERA_DEV_FIXTURES: "true" }, { production: true })).toThrow(ConfigError);
    expect(parseConfig({ VITE_VIXERA_DEV_FIXTURES: "true" }, { production: false }).mode).toBe("dev-fixtures");
    expect(parseConfig({ VITE_VIXERA_DEV_FIXTURES: "true" }).mode).toBe("dev-fixtures");
  });

  it("requires the Supabase url and anon key outside fixture mode", () => {
    expect(() => parseConfig({}, { production: true })).toThrow(ConfigError);
    expect(parseConfig({ VITE_SUPABASE_URL: "https://x.supabase.co", VITE_SUPABASE_ANON_KEY: "k" }, { production: true }).mode).toBe("supabase");
  });
});
