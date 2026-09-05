---
type: agent_requested
description: Use for Shopify inventory state, fulfilment delivery, return and refund operational analysis.
---

# Shopify inventory, fulfilment and returns

- Inventory is a current state at inventory-item/location grain. `on_hand` is
  physical stock; `available` is sellable. Committed, incoming, reserved,
  damaged, safety-stock and quality-control are states, not additive stock.
- A location with zero available is out of stock; low-stock classification uses
  the source safety-stock threshold. Do not invent a reorder point.
- Fulfilment, return and refund are different objects. A return can exist before
  a refund, and a fulfilment status does not prove delivery; use the delivered
  measures or day-or-coarser `delivered_at` bucket.
- Delivery is late only when delivered_at exceeds estimated_delivery_at. Missing
  estimates are unknown, never on-time by assumption.
- Fulfilment and return views are aggregate-only. Never request tracking values,
  exact event timestamps or an individual fulfilment, return or order identity.
