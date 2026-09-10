/**
 * On-demand server work the Field can request: a sync run and ingest
 * processing. Both are Edge Functions; dev-fixture mode substitutes local
 * equivalents (see bootstrap/dev-fixtures.ts).
 */
import type { SyncReport } from "@vixera/sync";
import type { FunctionsClient } from "./functions.ts";

export interface FieldServices {
  syncNow(connectorAccountId?: string | null): Promise<SyncReport>;
  processIngest(ingestItemId?: string | null): Promise<{ processed: number; documentIds: string[] }>;
}

export function createHttpServices(functions: FunctionsClient): FieldServices {
  return {
    async syncNow(connectorAccountId) {
      const { report } = await functions.call<{ report: SyncReport }>("connector-sync", connectorAccountId ? { connectorAccountId } : {});
      return report;
    },
    async processIngest(ingestItemId) {
      return functions.call<{ processed: number; documentIds: string[] }>("ingest-process", ingestItemId ? { ingestItemId } : {});
    },
  };
}
