import { DeputyConnector } from "../../../connectors/deputy/index.js";
import { DEPUTY_DEFAULT_SCOPES } from "../../../connectors/deputy/manifest.js";
import { LightspeedRConnector } from "../../../connectors/lightspeed-r/index.js";
import { LIGHTSPEED_R_DEFAULT_SCOPES } from "../../../connectors/lightspeed-r/manifest.js";
import { LightspeedXConnector } from "../../../connectors/lightspeed-x/index.js";
import { LIGHTSPEED_X_DEFAULT_SCOPES } from "../../../connectors/lightspeed-x/manifest.js";
import { GoogleAdsConnector } from "../../../connectors/google-ads/index.js";
import { GOOGLE_ADS_DEFAULT_SCOPES } from "../../../connectors/google-ads/manifest.js";
import { MetaAdsConnector } from "../../../connectors/meta-ads/index.js";
import { META_ADS_DEFAULT_SCOPES } from "../../../connectors/meta-ads/manifest.js";
import { MomenceConnector } from "../../../connectors/momence/index.js";
import { MOMENCE_DEFAULT_SCOPES } from "../../../connectors/momence/manifest.js";
import { ShopifyConnector } from "../../../connectors/shopify/index.js";
import { SHOPIFY_DEFAULT_SCOPES } from "../../../connectors/shopify/manifest.js";
import { SquareConnector } from "../../../connectors/square/index.js";
import { StripeConnector } from "../../../connectors/stripe/index.js";
import { STRIPE_DEFAULT_SCOPES } from "../../../connectors/stripe/manifest.js";
import { SQUARE_DEFAULT_SCOPES } from "../../../connectors/square/manifest.js";
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

export type OAuthConnectorConfig = Pick<
  SyncWorkerConfig,
  | "lightspeedClientId"
  | "lightspeedClientSecret"
  | "lightspeedXClientId"
  | "lightspeedXClientSecret"
  | "lightspeedXRedirectUri"
  | "xeroClientId"
  | "xeroEnableAdvancedJournals"
  | "deputyClientId"
  | "deputyClientSecret"
  | "deputyRedirectUri"
  | "squareClientId"
  | "squareClientSecret"
  | "squareRedirectUri"
  | "shopifyClientId"
  | "shopifyClientSecret"
  | "shopifyRedirectUri"
  | "stripeClientId"
  | "stripeSecretKey"
  | "stripeRedirectUri"
  | "momenceClientId"
  | "momenceClientSecret"
  | "momenceRedirectUri"
  | "metaAdsClientId"
  | "metaAdsClientSecret"
  | "metaAdsRedirectUri"
  | "googleAdsClientId"
  | "googleAdsClientSecret"
  | "googleAdsRedirectUri"
>;

/**
 * Vendors whose authorize host is the account itself need that identity before
 * a connector can be built. Only Shopify uses it today.
 */
export type ConnectorCreateOptions = Readonly<{ vendorAccountHint?: string | null }>;

export class ProductionConnectorFactory implements OAuthConnectorFactory {
  constructor(private readonly config: OAuthConnectorConfig) {}

  isConfigured(provider: Provider): boolean {
    if (provider === "lightspeed-x") {
      return Boolean(
        this.config.lightspeedXClientId && this.config.lightspeedXClientSecret,
      );
    }
    if (provider === "deputy") {
      return Boolean(
        this.config.deputyClientId && this.config.deputyClientSecret,
      );
    }
    if (provider === "square") {
      return Boolean(
        this.config.squareClientId && this.config.squareClientSecret,
      );
    }
    if (provider === "shopify") {
      return Boolean(
        this.config.shopifyClientId && this.config.shopifyClientSecret,
      );
    }
    if (provider === "momence") {
      return Boolean(
        this.config.momenceClientId && this.config.momenceClientSecret,
      );
    }
    return true;
  }

  create(
    provider: Provider,
    vault: WorkerCredentialVault,
    options: ConnectorCreateOptions = {},
  ): OAuthConnectorPack {
    if (provider === "lightspeed-r") {
      return new LightspeedRConnector({
        clientId: this.config.lightspeedClientId,
        clientSecret: this.config.lightspeedClientSecret,
        vault,
      });
    }
    if (provider === "lightspeed-x") {
      if (!this.isConfigured(provider)) {
        throw new Error("oauth_provider_not_configured:lightspeed-x");
      }
      return new LightspeedXConnector({
        clientId: this.config.lightspeedXClientId,
        clientSecret: this.config.lightspeedXClientSecret,
        redirectUri: this.config.lightspeedXRedirectUri,
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
    if (provider === "square") {
      if (!this.isConfigured("square")) throw new Error("oauth_provider_not_configured:square");
      return new SquareConnector({
        clientId: this.config.squareClientId,
        clientSecret: this.config.squareClientSecret,
        redirectUri: this.config.squareRedirectUri,
        vault,
      });
    }
    if (provider === "shopify") {
      if (!this.isConfigured("shopify")) throw new Error("oauth_provider_not_configured:shopify");
      if (!options.vendorAccountHint) {
        // Shopify's authorize and token hosts are the shop itself, so a
        // missing shop is a routing defect, not a recoverable default.
        throw new Error("oauth_shop_domain_required");
      }
      return new ShopifyConnector({
        clientId: this.config.shopifyClientId,
        clientSecret: this.config.shopifyClientSecret,
        redirectUri: this.config.shopifyRedirectUri,
        shopDomain: options.vendorAccountHint,
        vault,
      });
    }
    if (provider === "stripe") {
      if (!this.config.stripeClientId) throw new Error("oauth_provider_not_configured:stripe");
      return new StripeConnector({
        clientId: this.config.stripeClientId,
        secretKey: this.config.stripeSecretKey,
        redirectUri: this.config.stripeRedirectUri,
        vault,
      });
    }
    if (provider === "momence") {
      if (!this.isConfigured("momence")) throw new Error("oauth_provider_not_configured:momence");
      return new MomenceConnector({
        clientId: this.config.momenceClientId,
        clientSecret: this.config.momenceClientSecret,
        redirectUri: this.config.momenceRedirectUri,
        vault,
      });
    }
    if (provider === "meta-ads") {
      if (!this.config.metaAdsClientId) throw new Error("oauth_provider_not_configured:meta-ads");
      return new MetaAdsConnector({
        clientId: this.config.metaAdsClientId,
        clientSecret: this.config.metaAdsClientSecret,
        redirectUri: this.config.metaAdsRedirectUri,
        vault,
      });
    }
    if (provider === "google-ads") {
      if (!this.config.googleAdsClientId) throw new Error("oauth_provider_not_configured:google-ads");
      return new GoogleAdsConnector({
        clientId: this.config.googleAdsClientId,
        clientSecret: this.config.googleAdsClientSecret,
        redirectUri: this.config.googleAdsRedirectUri,
        vault,
      });
    }
    if (!this.isConfigured("deputy")) {
      throw new Error("oauth_provider_not_configured:deputy");
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
    if (provider === "lightspeed-x") return LIGHTSPEED_X_DEFAULT_SCOPES;
    if (provider === "xero") return xeroRequestedScopes(this.config.xeroEnableAdvancedJournals);
    if (provider === "square") return SQUARE_DEFAULT_SCOPES;
    if (provider === "shopify") return SHOPIFY_DEFAULT_SCOPES;
    if (provider === "stripe") return STRIPE_DEFAULT_SCOPES;
    if (provider === "momence") return MOMENCE_DEFAULT_SCOPES;
    if (provider === "meta-ads") return META_ADS_DEFAULT_SCOPES;
    if (provider === "google-ads") return GOOGLE_ADS_DEFAULT_SCOPES;
    return DEPUTY_DEFAULT_SCOPES;
  }
}

export class ProductionConnectorRegistry implements ConnectorRegistry {
  private readonly connectors: ReadonlyMap<Provider, OAuthConnectorPack>;
  private readonly accountBoundConnectors = new Map<string, OAuthConnectorPack>();

  constructor(
    private readonly factory: ProductionConnectorFactory,
    private readonly vault: WorkerCredentialVault,
  ) {
    const connectors: [Provider, OAuthConnectorPack][] = [
      ["lightspeed-r", factory.create("lightspeed-r", vault)],
      ["xero", factory.create("xero", vault)],
    ];
    if (factory.isConfigured("deputy")) {
      connectors.push(["deputy", factory.create("deputy", vault)]);
    }
    if (factory.isConfigured("lightspeed-x")) {
      connectors.push(["lightspeed-x", factory.create("lightspeed-x", vault)]);
    }
    if (factory.isConfigured("square")) {
      connectors.push(["square", factory.create("square", vault)]);
    }
    if (factory.isConfigured("momence")) {
      connectors.push(["momence", factory.create("momence", vault)]);
    }
    this.connectors = new Map(connectors);
  }

  get(
    provider: Provider,
    options: Readonly<{ externalAccountReference?: string | null }> = {},
  ): OAuthConnectorPack {
    if (provider === "shopify") {
      if (!this.factory.isConfigured("shopify")) {
        throw new Error("connector_not_configured:shopify");
      }
      const account = options.externalAccountReference?.trim().toLowerCase();
      if (!account) throw new Error("oauth_shop_domain_required");
      const key = `shopify:${account}`;
      const cached = this.accountBoundConnectors.get(key);
      if (cached) return cached;
      const connector = this.factory.create("shopify", this.vault, {
        vendorAccountHint: account,
      });
      this.accountBoundConnectors.set(key, connector);
      return connector;
    }
    const connector = this.connectors.get(provider);
    if (!connector) throw new Error(`connector_not_configured:${provider}`);
    return connector;
  }
}
