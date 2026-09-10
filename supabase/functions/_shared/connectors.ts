/**
 * Registry composition from server configuration. A provider whose secrets
 * are missing is simply absent from the registry: linking it returns
 * `provider_not_configured`, syncing its accounts records
 * "No connector registered" per capability, and nothing crashes at import.
 */
import { ConnectorRegistry } from "@vixera/domain";
import { MockConnector } from "@vixera/sync";
import { GoogleConnector } from "@vixera/connector-google";
import { MicrosoftConnector } from "@vixera/connector-microsoft";
import { createPlaidBankConnector } from "@vixera/connector-bank";
import { oauthRedirectUri, type FunctionEnv } from "./env.ts";

export interface RegistryOptions {
  /** Test hook: the mock connector instance to register when enabled. */
  readonly mock?: MockConnector;
}

export function buildRegistry(env: FunctionEnv, options: RegistryOptions = {}): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  if (env.google && env.functionsUrl) {
    registry.register(new GoogleConnector({ oauth: { clientId: env.google.clientId, clientSecret: env.google.clientSecret, redirectUri: oauthRedirectUri(env) } }));
  }
  if (env.microsoft && env.functionsUrl) {
    registry.register(
      new MicrosoftConnector({
        oauth: {
          clientId: env.microsoft.clientId,
          clientSecret: env.microsoft.clientSecret,
          redirectUri: oauthRedirectUri(env),
          ...(env.microsoft.tenant ? { tenant: env.microsoft.tenant } : {}),
        },
      }),
    );
  }
  if (env.plaid) {
    registry.register(createPlaidBankConnector({ clientId: env.plaid.clientId, secret: env.plaid.secret, environment: env.plaid.environment }));
  }
  if (env.enableMockConnector) registry.register(options.mock ?? new MockConnector());
  return registry;
}
