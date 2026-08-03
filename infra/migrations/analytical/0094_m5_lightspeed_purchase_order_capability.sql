BEGIN;

INSERT INTO semantic_internal.capability_vocabulary (
  capability,
  semantic_required,
  description
) VALUES (
  'inventory.purchase_orders',
  false,
  'Lightspeed Vendor identities and dependent Order lines support attributable purchase-order facts.'
)
ON CONFLICT (capability) DO UPDATE SET
  semantic_required=excluded.semantic_required,
  description=excluded.description;

COMMIT;
