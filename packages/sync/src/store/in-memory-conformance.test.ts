import { DEV_USER_ID } from "@vixera/domain";
import { InMemorySpineStore } from "./in-memory-spine-store.ts";
import { tickingClock } from "../testing/fixtures.ts";
import { runSpineStoreConformance } from "./conformance.ts";

runSpineStoreConformance("in-memory", () => ({
  store: new InMemorySpineStore(DEV_USER_ID, { now: tickingClock() }),
  userId: DEV_USER_ID,
}));
