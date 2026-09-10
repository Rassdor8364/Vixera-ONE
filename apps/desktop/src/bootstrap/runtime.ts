/**
 * Composition root of the Field.
 *
 *   createShell(config)             once at startup: mode, Supabase client (or the dev world),
 *                                   identity provider, Praxion client, screen-context registry
 *   createSessionRuntime(shell, id) once per signed-in user: the SpineReader bound to that
 *                                   user, the action dispatcher, storage, services, One Command
 *
 * Production reads through `SupabaseSpineStore` (RLS) and mutates only via
 * the action seam. Dev-fixture mode swaps in the in-memory world.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { CommandExecutor, CommandHistory, OneCommand, RuleBasedIntentRouter } from "@vixera/command";
import { type ScreenContextRegistry, type UserId } from "@vixera/domain";
import type { PraxionClient } from "@vixera/praxion";
import type { ExplicitCaptureAdapter } from "@vixera/screen-context";
import { SupabaseSpineStore, type SpineReader } from "@vixera/sync";
import { createHttpActionDispatcher, type ActionDispatcher } from "../data/actions.ts";
import { createHttpFunctionsClient, type FunctionsClient } from "../data/functions.ts";
import { createPraxionClient } from "../data/praxion.ts";
import { createFieldScreenContext } from "../data/screen-context.ts";
import { createHttpServices, type FieldServices } from "../data/services.ts";
import { createSupabaseArtifactStorage, type ArtifactStorage } from "../data/storage.ts";
import { getDeviceIdentity, type DeviceIdentity } from "../platform/device.ts";
import { functionsBaseUrl, type AppConfig, type AppMode } from "./config.ts";
// Type-only: the fixture world must never be linked into a production build.
import type { DevWorld } from "./dev-fixtures.ts";
import { installDevIdentity, installSessionIdentity, type SessionCurrentUserProvider } from "./identity.ts";

export interface AppShell {
  readonly config: AppConfig;
  readonly mode: AppMode;
  readonly supabase: SupabaseClient | null;
  readonly session: SessionCurrentUserProvider | null;
  readonly device: DeviceIdentity;
  readonly praxion: PraxionClient;
  readonly screenContext: ScreenContextRegistry;
  readonly explicitCapture: ExplicitCaptureAdapter;
  /** DEV ONLY. */
  readonly devWorld: DevWorld | null;
}

export interface SessionRuntime {
  readonly shell: AppShell;
  readonly mode: AppMode;
  readonly userId: UserId;
  readonly device: DeviceIdentity;
  readonly reader: SpineReader;
  readonly dispatch: ActionDispatcher;
  readonly functions: FunctionsClient | null;
  readonly services: FieldServices;
  readonly storage: ArtifactStorage;
  readonly praxion: PraxionClient;
  readonly screenContext: ScreenContextRegistry;
  readonly explicitCapture: ExplicitCaptureAdapter;
  readonly command: OneCommand;
  readonly supabase: SupabaseClient | null;
  /** Registers / refreshes this device's row (device identity, not context state). */
  registerDevice(praxionAvailable: boolean): Promise<void>;
}

export interface ShellOptions {
  readonly supabase?: SupabaseClient;
  readonly praxion?: PraxionClient;
  readonly device?: DeviceIdentity;
  readonly devWorld?: DevWorld;
}

export async function createShell(config: AppConfig, options: ShellOptions = {}): Promise<AppShell> {
  const device = options.device ?? (await getDeviceIdentity());
  const praxion = options.praxion ?? createPraxionClient(config.praxionBaseUrl);
  const { registry, explicit } = createFieldScreenContext(praxion);
  if (config.mode === "dev-fixtures") {
    installDevIdentity(config.devUserId);
    const devWorld = options.devWorld ?? (await (await import("./dev-fixtures.ts")).createDevWorld(config.devUserId));
    return { config, mode: "dev-fixtures", supabase: null, session: null, device, praxion, screenContext: registry, explicitCapture: explicit, devWorld };
  }
  const supabase = options.supabase ?? (await import("./supabase.ts")).createFieldSupabaseClient(config.supabaseUrl, config.supabaseAnonKey);
  const session = installSessionIdentity(supabase);
  await session.start();
  return { config, mode: "supabase", supabase, session, device, praxion, screenContext: registry, explicitCapture: explicit, devWorld: null };
}

export function createSessionRuntime(shell: AppShell, userId: UserId): SessionRuntime {
  const common = { shell, userId, device: shell.device, praxion: shell.praxion, screenContext: shell.screenContext, explicitCapture: shell.explicitCapture };
  const commandFor = (reader: SpineReader) =>
    new OneCommand({ router: new RuleBasedIntentRouter(reader), executor: new CommandExecutor(reader), history: new CommandHistory() });

  if (shell.mode === "dev-fixtures") {
    const world = shell.devWorld;
    if (!world) throw new Error("dev-fixture mode without a dev world");
    const reader = world.store;
    return {
      ...common,
      mode: "dev-fixtures",
      reader,
      dispatch: world.dispatch,
      functions: null,
      services: world.services,
      storage: world.storage,
      command: commandFor(reader),
      supabase: null,
      async registerDevice(praxionAvailable) {
        await world.store.upsertDevice({ id: shell.device.deviceId, platform: platformOf(shell.device), name: shell.device.name, praxionAvailable, lastSeenAt: new Date().toISOString() });
      },
    };
  }

  const supabase = shell.supabase;
  const session = shell.session;
  if (!supabase || !session) throw new Error("supabase mode without a client");
  const store = new SupabaseSpineStore(supabase, userId);
  const functions = createHttpFunctionsClient({
    baseUrl: functionsBaseUrl(shell.config.supabaseUrl),
    anonKey: shell.config.supabaseAnonKey,
    accessToken: async () => {
      const cached = session.currentSession();
      if (cached?.access_token && (cached.expires_at ?? Infinity) * 1000 > Date.now() + 30_000) return cached.access_token;
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token ?? null;
    },
  });
  return {
    ...common,
    mode: "supabase",
    reader: store,
    dispatch: createHttpActionDispatcher(functions),
    functions,
    services: createHttpServices(functions),
    storage: createSupabaseArtifactStorage(supabase),
    command: commandFor(store),
    supabase,
    async registerDevice(praxionAvailable) {
      await store.upsertDevice({ id: shell.device.deviceId, platform: platformOf(shell.device), name: shell.device.name, praxionAvailable, lastSeenAt: new Date().toISOString() });
    },
  };
}

function platformOf(device: DeviceIdentity): "windows" | "android" | "macos" | "ios" | "web" {
  switch (device.platform) {
    case "windows":
    case "android":
    case "macos":
    case "ios":
      return device.platform;
    default:
      return "web";
  }
}
