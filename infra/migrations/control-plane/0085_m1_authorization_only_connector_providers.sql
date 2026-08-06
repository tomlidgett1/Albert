-- Authorization-only connector packs (square, shopify, stripe, momence,
-- meta-ads, google-ads) authorise a vendor and store a rotating credential but
-- declare no stream, so they never ingest.
--
-- Three tables pinned the provider list as a hard CHECK written when only the
-- three ingesting packs existed. An OAuth start for any newer connector would
-- abort at the database, after the browser had already been sent to the
-- vendor, so the failure would surface as a broken callback rather than as a
-- configuration error. Widen the enumerations to the full connector set.
--
-- The list is still enumerated rather than relaxed to a pattern: an unknown
-- provider reaching these tables remains a defect worth rejecting.
--
-- Shopify additionally hosts its authorize endpoint on the merchant's own shop
-- (https://{shop}.myshopify.com/admin/oauth/authorize) rather than on a
-- central vendor domain, so the shop must be known before the redirect and
-- must survive until the callback. vendor_account_hint records it under the
-- worker's own authority; deriving it from the browser-supplied state at
-- callback time would let a signed-but-tampered value choose which host the
-- authorization code is exchanged against.

BEGIN;

ALTER TABLE control_plane.oauth_sessions
  DROP CONSTRAINT IF EXISTS oauth_sessions_provider_check;
ALTER TABLE control_plane.oauth_sessions
  ADD CONSTRAINT oauth_sessions_provider_check CHECK (
    provider IN (
      'lightspeed-r', 'xero', 'deputy', 'square',
      'shopify', 'stripe', 'momence', 'meta-ads', 'google-ads'
    )
  );

ALTER TABLE control_plane.live_vendor_attestation_challenges
  DROP CONSTRAINT IF EXISTS live_vendor_attestation_challenges_provider_check;
ALTER TABLE control_plane.live_vendor_attestation_challenges
  ADD CONSTRAINT live_vendor_attestation_challenges_provider_check CHECK (
    provider IN (
      'lightspeed-r', 'xero', 'deputy', 'square',
      'shopify', 'stripe', 'momence', 'meta-ads', 'google-ads'
    )
  );

ALTER TABLE control_plane.live_vendor_attestation_results
  DROP CONSTRAINT IF EXISTS live_vendor_attestation_results_provider_check;
ALTER TABLE control_plane.live_vendor_attestation_results
  ADD CONSTRAINT live_vendor_attestation_results_provider_check CHECK (
    provider IN (
      'lightspeed-r', 'xero', 'deputy', 'square',
      'shopify', 'stripe', 'momence', 'meta-ads', 'google-ads'
    )
  );

-- Nullable: only Shopify needs a pre-authorization account hint. The length
-- and character bounds keep an unvalidated value from ever reaching a URL.
ALTER TABLE control_plane.oauth_sessions
  ADD COLUMN IF NOT EXISTS vendor_account_hint text
    CHECK (
      vendor_account_hint IS NULL
      OR vendor_account_hint ~ '^[a-z0-9][a-z0-9.-]{1,98}[a-z0-9]$'
    );

-- Shopify cannot authorise without one; no other pack may carry one, so a
-- stray hint cannot silently redirect another connector's flow.
ALTER TABLE control_plane.oauth_sessions
  DROP CONSTRAINT IF EXISTS oauth_sessions_vendor_account_hint_provider_check;
ALTER TABLE control_plane.oauth_sessions
  ADD CONSTRAINT oauth_sessions_vendor_account_hint_provider_check CHECK (
    (provider = 'shopify' AND vendor_account_hint IS NOT NULL)
    OR (provider <> 'shopify' AND vendor_account_hint IS NULL)
  );

COMMIT;
