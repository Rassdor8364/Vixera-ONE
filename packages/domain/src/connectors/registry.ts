import type { ProviderId } from "../entities/connector-account.ts";
import type { Connector } from "./connector.ts";

/**
 * Provider → connector instance. The registry is the only place that knows
 * which providers exist; everything else asks for a connector by provider id.
 */
export class ConnectorRegistry {
  private readonly connectors = new Map<ProviderId, Connector>();

  register(connector: Connector): this {
    if (this.connectors.has(connector.provider)) {
      throw new Error(`Connector already registered for provider ${connector.provider}`);
    }
    this.connectors.set(connector.provider, connector);
    return this;
  }

  get(provider: ProviderId): Connector {
    const c = this.connectors.get(provider);
    if (!c) throw new Error(`No connector registered for provider ${provider}`);
    return c;
  }

  has(provider: ProviderId): boolean {
    return this.connectors.has(provider);
  }

  providers(): ProviderId[] {
    return [...this.connectors.keys()];
  }
}
