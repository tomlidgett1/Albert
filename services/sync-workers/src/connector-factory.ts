import { DeputyConnector } from "../../../connectors/deputy/index.js";
import { DEPUTY_DEFAULT_SCOPES } from "../../../connectors/deputy/manifest.js";
import { LightspeedRConnector } from "../../../connectors/lightspeed-r/index.js";
import { LIGHTSPEED_R_DEFAULT_SCOPES } from "../../../connectors/lightspeed-r/manifest.js";
import { XeroConnector } from "../../../connectors/xero/index.js";
import { xeroRequestedScopes } from "../../../connectors/xero/manifest.js";
import type {
  OAuthConnectorPack,
  WorkerCredentialVault,
} from "../../../packages/connector-sdk/src/index.js";
import type { SyncJob } from "../../../packages/queue/src/index.js";
import type { SyncWorkerConfig } from "./config.js";
import type { OAuthConnectorFactory } from "./oauth-http.js";
import type { ConnectorRegistry } from "./worker.js";

type Provider = SyncJob["connectorId"];

export class ProductionConnectorFactory implements OAuthConnectorFactory {
  constructor(private readonly config: SyncWorkerConfig) {}

  create(provider: Provider, vault: WorkerCredentialVault): OAuthConnectorPack {
    if (provider === "lightspeed-r") {
      return new LightspeedRConnector({
        clientId: this.config.lightspeedClientId,
        clientSecret: this.config.lightspeedClientSecret,
        vault,
      });
    }
    if (provider === "xero") {
      return new XeroConnector({
        clientId: this.config.xeroClientId,
        oauthMode: "pkce",
        vault,
      });
    }
    return new DeputyConnector({
      clientId: this.config.deputyClientId,
      clientSecret: this.config.deputyClientSecret,
      redirectUri: this.config.deputyRedirectUri,
      vault,
    });
  }

  scopes(provider: Provider): readonly string[] {
    if (provider === "lightspeed-r") return LIGHTSPEED_R_DEFAULT_SCOPES;
    if (provider === "xero") return xeroRequestedScopes(this.config.xeroEnableAdvancedJournals);
    return DEPUTY_DEFAULT_SCOPES;
  }
}

export class ProductionConnectorRegistry implements ConnectorRegistry {
  private readonly connectors: ReadonlyMap<Provider, OAuthConnectorPack>;

  constructor(factory: ProductionConnectorFactory, vault: WorkerCredentialVault) {
    this.connectors = new Map<Provider, OAuthConnectorPack>([
      ["lightspeed-r", factory.create("lightspeed-r", vault)],
      ["xero", factory.create("xero", vault)],
      ["deputy", factory.create("deputy", vault)],
    ]);
  }

  get(provider: Provider): OAuthConnectorPack {
    const connector = this.connectors.get(provider);
    if (!connector) throw new Error(`connector_not_configured:${provider}`);
    return connector;
  }
}
