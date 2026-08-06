import { Decimal4 } from "../../packages/canonical-schema/src/index.js";
import { stagingColumnName } from "../../packages/connector-sdk/src/index.js";
import { CanonicalRowNotApplicable } from "../../services/sync-workers/src/canonical-contract.js";
import type {
  CanonicalCategoryAssignmentCommand,
  CanonicalEntityType,
  CanonicalMappingContext,
  CanonicalProjectionCommand,
  CanonicalProjectionTable,
  CanonicalProjectionValue,
  CanonicalSourceReference,
  CanonicalStagingRow,
  CanonicalStreamMapper,
} from "../../services/sync-workers/src/canonical-contract.js";
import { lightspeedRManifest } from "./manifest.js";

const ZERO = Decimal4.zero();
const COMMON_STAGING_COLUMNS = new Set([
  "tenant_id",
  "namespaced_source_key",
  "connection_id",
  "external_account_reference",
  "source_object_type",
  "source_record_id",
  "source_version",
  "source_updated_at",
  "payload_hash",
  "payload_batch_id",
  "sync_run_id",
  "tombstone",
  "mapping_version",
  "first_ingested_at",
  "ingested_at",
]);

type JsonObject = Readonly<Record<string, unknown>>;

/** Pure, fail-closed Lightspeed R-Series typed-staging to canonical projection. */
/** Pure, fail-closed Lightspeed R-Series typed-staging to canonical projection. */
export const mapLightspeedCanonical: CanonicalStreamMapper = (stream, row, context) => {
  assertStagingRow(stream, row);
  switch (stream) {
    case "ls_shops": return mapShop(row, context);
    case "ls_registers": return mapRegister(row);
    case "ls_employees": return mapEmployee(row);
    case "ls_categories": return mapCategory(row);
    case "ls_items": return mapItem(row);
    case "ls_item_shops": return mapItemShop(row, context);
    case "ls_sales": return mapSale(row, context);
    case "ls_sale_lines": return mapSaleLine(row, context);
    case "ls_sale_payments": return mapSalePayment(row, context);
    case "ls_customers": return mapCustomer(row);
    case "ls_vendors": return mapVendor(row);
    case "ls_tax_categories": return mapTaxCategory(row);
    case "ls_inventory_logs": return mapInventoryLog(row, context);
    case "ls_purchase_order_lines": return mapPurchaseOrderLine(row, context);
    // Reference and lookup streams — including the purchase-order header,
    // whose lines are first-class rows carrying projected parent context —
    // observe identity without projecting canonical rows.
    default: return lookupOnly(row);
  }
};

/**
 * The one honest projection for a stream with no canonical target: record
 * that the row was observed and classified, so zero commands (a hard defect)
 * can never be confused with "nothing to say".
 */
function lookupOnly(row: CanonicalStagingRow): readonly CanonicalProjectionCommand[] {
  return [{
    kind: "metadata",
    sourceObjectType: row.source_object_type,
    sourceRecordId: requiredIdentifier(row.source_record_id, "metadata.source_record_id"),
    classification: "lookup_only",
  }];
}

function mapShop(row: CanonicalStagingRow, context: CanonicalMappingContext): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.shop_id, "ls_shops.shop_id");
  const name = requiredText(row.name, "ls_shops.name");
  const active = !truthy(row.archived) && !row.tombstone;
  const address = contactAddress(row.contact_json ?? row.contact);
  return [
    dimension("location", row.source_object_type, id, {
      name,
      timezone: optionalText(row.time_zone) ?? context.timezone,
      legal_entity_id: null,
      active,
    }, row, "location"),
    dimension("stock_location", row.source_object_type, id, {
      location_id: sourceRef("location", "Shop", id, row, { entityType: "location" }),
      name,
      active,
    }, row),
    identityHint("location", row.source_object_type, id, {
      externalId: id,
      deterministicKeys: {
        location_name_address: address ? `${normalizedName(name)}\u001f${address}` : undefined,
      },
      normalizedName: normalizedName(name),
    }),
  ];
}

function mapRegister(row: CanonicalStagingRow): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.register_id, "ls_registers.register_id");
  const shopId = requiredIdentifier(row.shop_id, "ls_registers.shop_id");
  return [dimension("register", row.source_object_type, id, {
    location_id: sourceRef("location", "Shop", shopId, row, { entityType: "location" }),
    name: optionalText(row.name) ?? `Register ${id}`,
    active: !row.tombstone,
  }, row)];
}

function mapEmployee(row: CanonicalStagingRow): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.employee_id, "ls_employees.employee_id");
  const displayName = composeDisplayName(row.first_name, row.last_name, `Employee ${id}`);
  const active = !truthy(row.archived) && !row.tombstone;
  const email = contactEmail(row.contact_json ?? row.contact);
  const scope = optionalIdentifier(row.last_shop_id);
  return [
    dimension("person", row.source_object_type, id, { display_name: displayName }, row),
    dimension("worker", row.source_object_type, id, {
      person_id: sourceRef("person", "Employee", id, row),
      display_name: displayName,
      active,
    }, row, "worker"),
    identityHint("worker", row.source_object_type, id, {
      externalId: id,
      deterministicKeys: { work_email: email },
      normalizedName: normalizedName(displayName),
      corroboratingScopeRef: scope
        ? { sourceObjectType: "Shop", sourceRecordId: scope }
        : undefined,
    }),
  ];
}

function mapCategory(row: CanonicalStagingRow): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.category_id, "ls_categories.category_id");
  const parentId = optionalIdentifier(row.parent_id);
  return [dimension("product_category", row.source_object_type, id, {
    parent_category_id: parentId
      ? sourceRef("product_category", "Category", parentId, row, { nullable: true })
      : null,
    name: requiredText(row.name, "ls_categories.name"),
    active: !row.tombstone,
  }, row)];
}

function mapItem(row: CanonicalStagingRow): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.item_id, "ls_items.item_id");
  const sku = optionalText(row.system_sku) ?? optionalText(row.custom_sku);
  const name = optionalText(row.description) ?? sku ?? `Item ${id}`;
  const barcode = optionalText(row.upc) ?? optionalText(row.ean);
  const active = !truthy(row.archived) && !row.tombstone;
  const commands: CanonicalProjectionCommand[] = [
    dimension("product", row.source_object_type, id, { name, active }, row),
    dimension("product_variant", row.source_object_type, id, {
      product_id: sourceRef("product", "Item", id, row),
      name,
      sku,
      barcode,
      active,
    }, row, "product_variant"),
    identityHint("product_variant", row.source_object_type, id, {
      externalId: id,
      deterministicKeys: {
        system_sku: optionalText(row.system_sku) ?? undefined,
        custom_sku: optionalText(row.custom_sku) ?? undefined,
        upc: optionalText(row.upc) ?? undefined,
        ean: optionalText(row.ean) ?? undefined,
      },
      normalizedName: normalizedName(name),
    }),
  ];
  const categoryId = optionalIdentifier(row.category_id);
  if (categoryId) {
    commands.push({
      kind: "category_assignment",
      sourceObjectType: row.source_object_type,
      sourceRecordId: id,
      productVariant: sourceRef("product_variant", "Item", id, row, { entityType: "product_variant" }),
      productCategory: sourceRef("product_category", "Category", categoryId, row),
      effectiveFrom: optionalInstant(row.source_updated_at) ?? undefined,
      tombstone: row.tombstone || undefined,
    } satisfies CanonicalCategoryAssignmentCommand);
  }
  return commands;
}

function mapItemShop(row: CanonicalStagingRow, context: CanonicalMappingContext): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.item_shop_id, "ls_item_shops.item_shop_id");
  const itemId = requiredIdentifier(row.item_id, "ls_item_shops.item_id");
  assertNotAggregateShopScope(row.shop_id, "item_shops");
  const shopId = requiredIdentifier(row.shop_id, "ls_item_shops.shop_id");
  // ItemShop is a mutable current-balance resource. Its vendor timestamp is a
  // change timestamp, not the time Albert observed the balance. Reconciliation
  // sweeps deliberately re-observe every row and preserve one snapshot a day.
  const snapshotAt = requiredInstant(
    row.ingested_at ?? row.updated_at ?? row.source_updated_at,
    "ls_item_shops.ingested_at",
  );
  const snapshotDate = localCalendarDate(snapshotAt, context.timezone);
  const quantity = decimalOrZero(row.qoh, "ls_item_shops.qoh");
  const unitCost = optionalCostDecimal(row.avg_cost, "ls_item_shops.avg_cost");
  const stockValue = unitCost ? Decimal4.from(unitCost).multiply(Decimal4.from(quantity)).toString() : null;
  return [fact("inventory_balance_snapshot", "ItemShopDailySnapshot", `${id}#snapshot:${snapshotDate}`, {
    product_variant_id: sourceRef("product_variant", "Item", itemId, row, { entityType: "product_variant" }),
    stock_location_id: sourceRef("stock_location", "Shop", shopId, row),
    snapshot_at: snapshotAt,
    snapshot_date: snapshotDate,
    quantity_on_hand: quantity,
    unit_cost: unitCost,
    stock_value: stockValue,
    currency: context.baseCurrency,
  }, "stock")];
}

/** The synthetic in-store channel every POS observation references. */
const CHANNEL_OBJECT_TYPE = "LightspeedChannel";
const CHANNEL_RECORD_ID = "in_store";

/**
 * Sale headers own the order and nothing below it: lines and payments are
 * first-class rows of their own streams, so one economic event can never
 * project twice. The header also emits the synthetic in-store channel and a
 * register stub, so arrival order can never dangle an order's references.
 */
function mapSale(row: CanonicalStagingRow, context: CanonicalMappingContext): readonly CanonicalProjectionCommand[] {
  const saleId = requiredIdentifier(row.sale_id, "ls_sales.sale_id");
  const shopId = requiredIdentifier(row.shop_id, "ls_sales.shop_id");
  const orderedAt = requiredInstant(
    row.create_time ?? row.complete_time ?? row.time_stamp ?? row.source_updated_at,
    "ls_sales.ordered_at",
  );
  const completedAt = optionalInstant(row.complete_time);
  const businessDate = tradingBusinessDate(completedAt ?? orderedAt, context);
  const voided = truthy(row.voided) || row.tombstone;
  const completed = truthy(row.completed);
  const orderStatus = voided ? "voided" : completed ? "completed" : "open";

  const commands: CanonicalProjectionCommand[] = [
    dimension("channel", CHANNEL_OBJECT_TYPE, CHANNEL_RECORD_ID, {
      name: "In-store",
      channel_type: "in_store",
      active: true,
    }, row),
  ];
  const registerId = optionalIdentifier(row.register_id);
  if (registerId) {
    commands.push(dimension("register", "Register", registerId, {
      location_id: sourceRef("location", "Shop", shopId, row, { entityType: "location" }),
      name: `Register ${registerId}`,
      active: !row.tombstone,
    }, row));
  }

  const net = optionalDecimalValue(row.total, "ls_sales.total")
    ?? optionalDecimalValue(row.calc_total, "ls_sales.calc_total")
    ?? ZERO;
  const discount = optionalDecimalValue(row.calc_discount, "ls_sales.calc_discount") ?? ZERO;
  const tax = (optionalDecimalValue(row.calc_tax1, "ls_sales.calc_tax1") ?? ZERO)
    .add(optionalDecimalValue(row.calc_tax2, "ls_sales.calc_tax2") ?? ZERO);
  commands.push(fact("commerce_order", row.source_object_type, saleId, {
    location_id: sourceRef("location", "Shop", shopId, row, { entityType: "location" }),
    register_id: registerId ? sourceRef("register", "Register", registerId, row) : null,
    channel_id: sourceRef("channel", CHANNEL_OBJECT_TYPE, CHANNEL_RECORD_ID, row),
    customer_account_id: optionalEntityRef("customer_account", "Customer", row.customer_id, row, "customer_account"),
    worker_id: optionalEntityRef("worker", "Employee", row.employee_id, row, "worker"),
    ordered_at: orderedAt,
    completed_at: completedAt,
    fulfilled_at: completedAt,
    business_date: businessDate,
    status: orderStatus,
    voided,
    internal_transaction: false,
    gross_amount: net.add(discount).toString(),
    discount_amount: discount.toString(),
    net_amount_inc_tax: net.toString(),
    tax_amount: tax.toString(),
    net_amount_ex_tax: net.subtract(tax).toString(),
    total_cost: optionalDecimal(row.calc_avg_cost, "ls_sales.calc_avg_cost"),
    currency: context.baseCurrency,
  }, "operational_sales", row.tombstone));
  return commands;
}

/**
 * One sale line, mapped standalone from its own row. Parent context —
 * completed, voided, completion time — is projected onto the row by the walk,
 * which is what makes a line's status honest without its header in hand. A
 * negative quantity is a reversal observation: it projects the refund fact
 * and its link to the original line, never an additional positive sale.
 */
function mapSaleLine(row: CanonicalStagingRow, context: CanonicalMappingContext): readonly CanonicalProjectionCommand[] {
  const lineId = requiredIdentifier(row.sale_line_id, "ls_sale_lines.sale_line_id");
  const saleId = requiredIdentifier(row.sale_id, "ls_sale_lines.sale_id");
  const shopId = requiredIdentifier(row.shop_id, "ls_sale_lines.shop_id");
  const orderedAt = requiredInstant(
    row.create_time ?? row.time_stamp ?? row.source_updated_at,
    "ls_sale_lines.ordered_at",
  );
  const completedAt = optionalInstant(row.complete_time);
  const businessDate = tradingBusinessDate(completedAt ?? orderedAt, context);
  const voided = truthy(row.voided) || row.tombstone;
  const completed = truthy(row.completed);

  const quantity = decimalOrZeroValue(row.unit_quantity, "ls_sale_lines.unit_quantity");
  const unitPrice = decimalOrZeroValue(row.unit_price, "ls_sale_lines.unit_price");
  const rawDiscount = optionalDecimalValue(row.discount_amount, "ls_sale_lines.discount_amount") ?? ZERO;
  const lineDiscount = optionalDecimalValue(row.calc_line_discount, "ls_sale_lines.calc_line_discount");
  const transactionDiscount = optionalDecimalValue(row.calc_transaction_discount, "ls_sale_lines.calc_transaction_discount");
  // discount_amount is the configured dollar-discount input. The two calc_*
  // fields are the applied line and transaction allocations and therefore
  // include percentage discounts. Older recordings may omit the calculated
  // fields, so retain the signed input as a compatibility fallback.
  const discount = lineDiscount || transactionDiscount
    ? (lineDiscount ?? ZERO).add(transactionDiscount ?? ZERO)
    : quantity.scaled < 0n ? negate(rawDiscount.abs()) : rawDiscount.abs();
  const netIncTax = optionalDecimalValue(row.calc_total, "ls_sale_lines.calc_total")
    ?? unitPrice.multiply(quantity).subtract(discount);
  const tax = (optionalDecimalValue(row.calc_tax1, "ls_sale_lines.calc_tax1") ?? ZERO)
    .add(optionalDecimalValue(row.calc_tax2, "ls_sale_lines.calc_tax2") ?? ZERO);
  const unitCost = optionalCostDecimalValue(row.avg_cost, "ls_sale_lines.avg_cost");
  const itemId = optionalIdentifier(row.item_id);
  const workerId = optionalIdentifier(row.employee_id);
  const taxCategoryId = optionalIdentifier(row.tax_category_id);
  const refund = quantity.scaled < 0n;
  const orderStatus = voided ? "voided" : refund ? "refunded" : completed ? "completed" : "open";

  const commands: CanonicalProjectionCommand[] = [fact("commerce_order_line", row.source_object_type, lineId, {
    order_id: sourceRef("commerce_order", "Sale", saleId, row),
    line_number: stablePositiveInteger(lineId),
    product_variant_id: itemId
      ? sourceRef("product_variant", "Item", itemId, row, { entityType: "product_variant", nullable: true })
      : null,
    location_id: sourceRef("location", "Shop", shopId, row, { entityType: "location" }),
    register_id: null,
    channel_id: sourceRef("channel", CHANNEL_OBJECT_TYPE, CHANNEL_RECORD_ID, row),
    customer_account_id: optionalEntityRef("customer_account", "Customer", row.customer_id, row, "customer_account"),
    worker_id: workerId
      ? sourceRef("worker", "Employee", workerId, row, { entityType: "worker", nullable: true })
      : null,
    tax_code_id: taxCategoryId
      ? sourceRef("tax_code", "TaxCategory", taxCategoryId, row, { nullable: true })
      : null,
    ordered_at: orderedAt,
    completed_at: completedAt,
    fulfilled_at: completedAt,
    business_date: businessDate,
    // Refund lines remain on their source sale so the signed line set
    // reconciles the source header. The governed sales event excludes this
    // refunded order-line projection and uses commerce_refund_line instead,
    // avoiding double-counting while preserving the original-line link.
    order_status: orderStatus,
    voided,
    internal_transaction: false,
    quantity: quantity.toString(),
    unit_price: unitPrice.toString(),
    unit_cost: unitCost?.toString() ?? null,
    gross_amount: netIncTax.add(discount).toString(),
    discount_amount: discount.toString(),
    net_amount_inc_tax: netIncTax.toString(),
    tax_amount: tax.toString(),
    net_amount_ex_tax: netIncTax.subtract(tax).toString(),
    total_cost: unitCost?.multiply(quantity).toString() ?? null,
    currency: context.baseCurrency,
  }, "operational_sales", row.tombstone)];

  if (refund) {
    const parentLineId = optionalIdentifier(row.parent_sale_line_id);
    if (!parentLineId) {
      throw new Error(`lightspeed_refund_parent_missing:${saleId}:${lineId}`);
    }
    const refundTax = tax.abs();
    const amount = netIncTax.abs();
    commands.push(fact("commerce_refund_line", row.source_object_type, lineId, {
      original_order_line_id: sourceRef("commerce_order_line", row.source_object_type, parentLineId, row),
      location_id: sourceRef("location", "Shop", shopId, row, { entityType: "location" }),
      product_variant_id: itemId
        ? sourceRef("product_variant", "Item", itemId, row, { entityType: "product_variant", nullable: true })
        : null,
      worker_id: workerId
        ? sourceRef("worker", "Employee", workerId, row, { entityType: "worker", nullable: true })
        : null,
      refunded_at: completedAt ?? orderedAt,
      business_date: businessDate,
      quantity: quantity.abs().toString(),
      refund_amount_inc_tax: amount.toString(),
      tax_amount: refundTax.toString(),
      refund_amount_ex_tax: amount.subtract(refundTax).toString(),
      total_cost_reversed: unitCost?.multiply(quantity.abs()).toString() ?? null,
      currency: context.baseCurrency,
    }, "operational_sales"));
    commands.push({
      kind: "event_link",
      linkType: "reversal_of",
      from: { connectionId: row.connection_id, sourceObjectType: row.source_object_type, sourceRecordId: lineId },
      to: { connectionId: row.connection_id, sourceObjectType: row.source_object_type, sourceRecordId: parentLineId },
      evidence: { sale_id: saleId, quantity: quantity.toString(), amount: netIncTax.toString() },
    });
  }
  return commands;
}

/**
 * One tender, mapped standalone. The sale's shop and lifecycle ride the row
 * as projected parent context, because a payment carries no location of its
 * own and its status depends on whether the sale it settles was voided.
 */
function mapSalePayment(row: CanonicalStagingRow, context: CanonicalMappingContext): readonly CanonicalProjectionCommand[] {
  const paymentId = requiredIdentifier(row.sale_payment_id, "ls_sale_payments.sale_payment_id");
  const saleId = requiredIdentifier(row.sale_id, "ls_sale_payments.sale_id");
  const shopId = requiredIdentifier(row.shop_id, "ls_sale_payments.shop_id");
  const amount = decimalOrZeroValue(row.amount, "ls_sale_payments.amount");
  const paidAt = optionalInstant(row.create_time)
    ?? optionalInstant(row.complete_time)
    ?? requiredInstant(row.source_updated_at, "ls_sale_payments.paid_at");
  const archived = truthy(row.archived);
  const voided = truthy(row.voided) || row.tombstone;
  return [fact("commerce_payment", row.source_object_type, paymentId, {
    order_id: sourceRef("commerce_order", "Sale", saleId, row),
    location_id: sourceRef("location", "Shop", shopId, row, { entityType: "location" }),
    channel_id: sourceRef("channel", CHANNEL_OBJECT_TYPE, CHANNEL_RECORD_ID, row),
    paid_at: paidAt,
    business_date: tradingBusinessDate(paidAt, context),
    tender_type: optionalIdentifier(row.payment_type_id) ?? "unknown",
    status: voided || archived ? "voided" : amount.scaled < 0n ? "refunded" : "captured",
    amount: amount.toString(),
    currency: context.baseCurrency,
  }, "operational_sales", row.tombstone || archived)];
}

function mapCustomer(row: CanonicalStagingRow): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.customer_id, "ls_customers.customer_id");
  const name = optionalText(row.company)
    ?? composeDisplayName(row.first_name, row.last_name, `Customer ${id}`);
  const email = contactEmail(row.contact_json ?? row.contact);
  return [
    dimension("person", row.source_object_type, id, { display_name: name }, row),
    dimension("customer_account", row.source_object_type, id, {
      person_id: sourceRef("person", "Customer", id, row),
      display_name: name,
      first_order_at: null,
      last_order_at: null,
    }, row, "customer_account"),
    identityHint("customer_account", row.source_object_type, id, {
      externalId: id,
      deterministicKeys: { email },
      normalizedName: normalizedName(name),
    }),
  ];
}

function mapVendor(row: CanonicalStagingRow): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.vendor_id, "ls_vendors.vendor_id");
  const name = requiredText(row.name, "ls_vendors.name");
  const active = !truthy(row.archived) && !row.tombstone;
  return [
    dimension("supplier", row.source_object_type, id, {
      name,
      abn: null,
      active,
    }, row, "supplier"),
    identityHint("supplier", row.source_object_type, id, {
      // Source IDs are namespaced by connector and object type before identity
      // persistence; supplier names only produce reviewable cross-source hints.
      externalId: id,
      deterministicKeys: {},
      normalizedName: normalizedName(name),
    }),
  ];
}

/**
 * One purchase-order line, mapped standalone from its own row plus the parent
 * context the walk projected onto it (vendor, destination shop, lifecycle
 * dates, currency). The Order header stream is a lookup-only identity sweep.
 */
function mapPurchaseOrderLine(row: CanonicalStagingRow, context: CanonicalMappingContext): readonly CanonicalProjectionCommand[] {
  const lineId = requiredIdentifier(row.order_line_id, "ls_purchase_order_lines.order_line_id");
  const orderId = requiredIdentifier(row.order_id, "ls_purchase_order_lines.order_id");
  if (row.tombstone) {
    return [{
      kind: "fact",
      table: "purchase_order_line",
      sourceObjectType: row.source_object_type,
      sourceRecordId: lineId,
      values: { status: "cancelled" },
      authorityConcept: "stock",
      tombstone: true,
      updateOnly: true,
    }];
  }
  const supplierId = optionalIdentifier(row.vendor_id);
  const shopId = optionalIdentifier(row.shop_id);
  const itemId = optionalIdentifier(row.item_id);
  const orderedAt = requiredInstant(
    row.ordered_date ?? row.create_time ?? row.source_updated_at,
    "ls_purchase_order_lines.ordered_at",
  );
  const receivedAt = optionalInstant(row.received_date);
  const status = truthy(row.archived)
    ? "cancelled"
    : truthy(row.complete) ? "completed" : receivedAt ? "partially_received" : "open";
  const quantity = decimalOrZeroValue(row.quantity, "ls_purchase_order_lines.quantity");
  // Staging columns are the snake_case api leaves: `price` is the documented
  // discounted unit COST, `checked_in` the units added to inventory, `total`
  // the documented quantity x price line cost.
  const received = optionalDecimalValue(row.checked_in, "ls_purchase_order_lines.checked_in")
    ?? (status === "completed" ? quantity : ZERO);
  const unitCost = optionalDecimalValue(row.price, "ls_purchase_order_lines.price");
  const totalCost = optionalDecimalValue(row.total, "ls_purchase_order_lines.total")
    ?? unitCost?.multiply(quantity)
    ?? null;
  return [fact("purchase_order_line", row.source_object_type, lineId, {
    purchase_order_ref: orderId,
    line_number: stablePositiveInteger(lineId),
    supplier_id: supplierId
      ? sourceRef("supplier", "Vendor", supplierId, row, { entityType: "supplier", nullable: true })
      : null,
    product_variant_id: itemId
      ? sourceRef("product_variant", "Item", itemId, row, { entityType: "product_variant", nullable: true })
      : null,
    stock_location_id: shopId ? sourceRef("stock_location", "Shop", shopId, row, { nullable: true }) : null,
    ordered_at: orderedAt,
    expected_at: null,
    received_at: receivedAt,
    business_date: localCalendarDate(orderedAt, context.timezone),
    status,
    ordered_quantity: quantity.toString(),
    received_quantity: received.toString(),
    unit_cost: unitCost?.toString() ?? null,
    total_cost: totalCost instanceof Decimal4 ? totalCost.toString() : totalCost,
    currency: optionalText(row.vendor_currency_code)?.toUpperCase() ?? context.baseCurrency,
  }, "stock", row.tombstone)];
}

function mapTaxCategory(row: CanonicalStagingRow): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.tax_category_id, "ls_tax_categories.tax_category_id");
  const rate = decimalOrZero(row.tax1_rate, "ls_tax_categories.tax1_rate");
  return [dimension("tax_code", row.source_object_type, id, {
    name: optionalText(row.tax1_name) ?? optionalText(row.tax2_name) ?? `Tax ${id}`,
    rate,
    input_or_output: "output",
  }, row)];
}

function mapInventoryLog(row: CanonicalStagingRow, context: CanonicalMappingContext): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.inventory_log_id, "ls_inventory_logs.inventory_log_id");
  const itemId = requiredIdentifier(row.item_id, "ls_inventory_logs.item_id");
  assertNotAggregateShopScope(row.shop_id, "inventory_logs");
  const shopId = requiredIdentifier(row.shop_id, "ls_inventory_logs.shop_id");
  const occurredAt = requiredInstant(
    row.created_at ?? row.create_time ?? row.source_updated_at,
    "ls_inventory_logs.created_at",
  );
  const quantity = decimalOrZero(row.qoh_change, "ls_inventory_logs.qoh_change");
  const unitCost = optionalCostDecimal(row.cost_change, "ls_inventory_logs.cost_change");
  return [fact("inventory_movement", row.source_object_type, id, {
    product_variant_id: sourceRef("product_variant", "Item", itemId, row, { entityType: "product_variant" }),
    stock_location_id: sourceRef("stock_location", "Shop", shopId, row),
    movement_type: inventoryMovementType(row.reason, truthy(row.automated)),
    occurred_at: occurredAt,
    business_date: tradingBusinessDate(occurredAt, context),
    quantity_delta: quantity,
    unit_cost: unitCost,
    total_cost: unitCost ? Decimal4.from(unitCost).multiply(Decimal4.from(quantity)).toString() : null,
    currency: context.baseCurrency,
  }, "stock")];
}

function assertStagingRow(stream: string, row: CanonicalStagingRow): void {
  const contract = lightspeedRManifest.streams.find((candidate) => candidate.id === stream);
  if (!contract) throw new Error(`lightspeed_canonical_stream_unsupported:${stream}`);
  if (row.source_object_type !== contract.resource) {
    throw new Error(`lightspeed_canonical_source_type_mismatch:${stream}:${row.source_object_type}`);
  }
  const coverage = lightspeedRManifest.fieldCoverage.filter((field) => field.stream === stream);
  const allowed = new Set([...COMMON_STAGING_COLUMNS, ...coverage.map((field) => stagingColumnName(field.field))]);
  const drift = Object.keys(row).filter((column) => !allowed.has(column));
  if (drift.length > 0) throw new Error(`lightspeed_canonical_staging_drift:${stream}:${drift.sort().join(",")}`);
  const stagedId = requiredIdentifier(row[stagingColumnName(contract.recordIdField)], `${stream}.record_id`);
  if (stagedId !== row.source_record_id) {
    throw new Error(`lightspeed_canonical_source_id_mismatch:${stream}:${stagedId}:${row.source_record_id}`);
  }
}

function dimension(
  table: CanonicalProjectionTable,
  sourceObjectType: string,
  sourceRecordId: string,
  values: Readonly<Record<string, CanonicalProjectionValue>>,
  row: CanonicalStagingRow,
  entityType?: CanonicalEntityType,
): CanonicalProjectionCommand {
  return {
    kind: "dimension",
    table,
    sourceObjectType,
    sourceRecordId,
    values,
    tombstone: row.tombstone || undefined,
    entityType,
  } as CanonicalProjectionCommand;
}

function fact(
  table: CanonicalProjectionTable,
  sourceObjectType: string,
  sourceRecordId: string,
  values: Readonly<Record<string, CanonicalProjectionValue>>,
  authorityConcept: "operational_sales" | "stock" | "product_master",
  tombstone = false,
): CanonicalProjectionCommand {
  return {
    kind: "fact",
    table,
    sourceObjectType,
    sourceRecordId,
    values,
    authorityConcept,
    tombstone: tombstone || undefined,
  } as CanonicalProjectionCommand;
}

function identityHint(
  entityType: CanonicalEntityType,
  sourceObjectType: string,
  sourceRecordId: string,
  fields: Readonly<{
    externalId?: string;
    deterministicKeys: Readonly<Record<string, string | undefined>>;
    normalizedName?: string;
    corroboratingScope?: string;
    corroboratingScopeRef?: Readonly<{ sourceObjectType: string; sourceRecordId: string }>;
  }>,
): CanonicalProjectionCommand {
  return { kind: "identity_hint", entityType, sourceObjectType, sourceRecordId, ...fields };
}

function sourceRef(
  table: CanonicalProjectionTable,
  sourceObjectType: string,
  sourceRecordId: string,
  row: CanonicalStagingRow,
  options: Readonly<{ entityType?: CanonicalEntityType; nullable?: boolean }> = {},
): CanonicalSourceReference {
  return {
    sourceRef: {
      table,
      sourceObjectType,
      sourceRecordId,
      connectionId: row.connection_id,
      ...options,
    },
  };
}

function optionalEntityRef(
  table: CanonicalProjectionTable,
  sourceObjectType: string,
  value: unknown,
  row: CanonicalStagingRow,
  entityType: CanonicalEntityType,
): CanonicalSourceReference | null {
  const id = optionalIdentifier(value);
  return id ? sourceRef(table, sourceObjectType, id, row, { entityType, nullable: true }) : null;
}






function negate(value: Decimal4): Decimal4 {
  return Decimal4.fromScaled(-value.scaled);
}

function decimalOrZero(value: unknown, path: string): string {
  return decimalOrZeroValue(value, path).toString();
}

function decimalOrZeroValue(value: unknown, path: string): Decimal4 {
  return optionalDecimalValue(value, path) ?? ZERO;
}

function optionalDecimal(value: unknown, path: string): string | null {
  return optionalDecimalValue(value, path)?.toString() ?? null;
}

/**
 * Cost-only decimal reader.
 *
 * R-Series derives averageCost, cost_change and the FIFO costs by division and
 * reports them at nine decimal places. Money and quantity stay on the exact
 * parser, where an unrepresentable value is a mapping error; a derived cost
 * that the canonical scale cannot hold exactly is rounded here instead, so a
 * whole sale is not quarantined over a sub-cent cost tail.
 */
function optionalCostDecimal(value: unknown, path: string): string | null {
  return optionalCostDecimalValue(value, path)?.toString() ?? null;
}

function optionalCostDecimalValue(value: unknown, path: string): Decimal4 | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`lightspeed_canonical_decimal_invalid:${path}`);
  }
  try {
    return Decimal4.fromRounded(typeof value === "bigint" ? value : String(value));
  } catch {
    throw new Error(`lightspeed_canonical_decimal_invalid:${path}`);
  }
}

function optionalDecimalValue(value: unknown, path: string): Decimal4 | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`lightspeed_canonical_decimal_invalid:${path}`);
  }
  try {
    return Decimal4.from(typeof value === "bigint" ? value : String(value));
  } catch {
    throw new Error(`lightspeed_canonical_decimal_invalid:${path}`);
  }
}

function requiredText(value: unknown, path: string): string {
  const text = optionalText(value);
  if (!text) throw new Error(`lightspeed_canonical_text_missing:${path}`);
  return text;
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function requiredIdentifier(value: unknown, path: string): string {
  const id = optionalIdentifier(value);
  if (!id) throw new Error(`lightspeed_canonical_id_missing:${path}`);
  return id;
}

/**
 * R-Series emits a parallel row under the sentinel shop `0` for every real
 * per-shop row: the all-shops roll-up it derives from those same rows. It has
 * no Shop record, so projecting it would dangle a stock_location reference and
 * double count every balance. Observe it and project nothing.
 *
 * A genuinely absent shop id is left to `requiredIdentifier` — only the exact
 * sentinel is treated as the roll-up scope.
 */
function assertNotAggregateShopScope(value: unknown, stream: string): void {
  if (optionalText(value) === "0") {
    throw new CanonicalRowNotApplicable(`lightspeed_${stream}_aggregate_shop_scope`);
  }
}

function optionalIdentifier(value: unknown): string | null {
  const id = optionalText(value);
  return id && id !== "0" ? id : null;
}

function truthy(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return typeof value === "string" && ["1", "true", "yes", "active", "completed"].includes(value.trim().toLowerCase());
}

function inventoryMovementType(value:unknown,automated:boolean):string{
  const reason=optionalText(value)?.toLowerCase()??"";
  if(/receiv|purchase/u.test(reason))return"receipt";
  if(/sale|sold/u.test(reason))return"sale";
  if(/return/u.test(reason))return"return";
  if(/transfer/u.test(reason))return"transfer";
  if(/stock[ _-]?take|count/u.test(reason))return"stocktake";
  if(/adjust|correct/u.test(reason))return"adjustment";
  if(automated||/automat/u.test(reason))return"automated";
  return"unknown";
}

function requiredInstant(value: unknown, path: string): string {
  const instant = optionalInstant(value);
  if (!instant) throw new Error(`lightspeed_canonical_timestamp_missing:${path}`);
  return instant;
}

function optionalInstant(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function localCalendarDate(instant: string, timezone: string): string {
  const parts = localParts(instant, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function tradingBusinessDate(instant: string, context: CanonicalMappingContext): string {
  const parts = localParts(instant, context.timezone);
  const cutoff = /^(\d{2}):(\d{2})(?::\d{2})?$/u.exec(context.tradingDayCutoff);
  if (!cutoff) throw new Error("lightspeed_canonical_trading_cutoff_invalid");
  const cutoffMinutes = Number(cutoff[1]) * 60 + Number(cutoff[2]);
  if (cutoffMinutes < 0 || cutoffMinutes >= 1_440) {
    throw new Error("lightspeed_canonical_trading_cutoff_invalid");
  }
  const localMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (localMinutes >= cutoffMinutes) return `${parts.year}-${parts.month}-${parts.day}`;
  const previous = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) - 1));
  return previous.toISOString().slice(0, 10);
}

function localParts(instant: string, timezone: string): Readonly<Record<"year" | "month" | "day" | "hour" | "minute", string>> {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const values = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  for (const key of ["year", "month", "day", "hour", "minute"] as const) {
    if (!values[key]) throw new Error(`lightspeed_canonical_local_time_missing:${key}`);
  }
  return values as Record<"year" | "month" | "day" | "hour" | "minute", string>;
}

function composeDisplayName(first: unknown, last: unknown, fallback: string): string {
  return [optionalText(first), optionalText(last)].filter(Boolean).join(" ") || fallback;
}

function normalizedName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function contactEmail(value: unknown): string | undefined {
  const contact = asObject(value);
  const emails = asObject(contact?.Emails);
  const candidates = emails?.ContactEmail;
  const list = Array.isArray(candidates) ? candidates : candidates ? [candidates] : [];
  for (const candidate of list) {
    const email = optionalText(asObject(candidate)?.address)?.toLowerCase();
    if (email) return email;
  }
  return undefined;
}

function contactAddress(value: unknown): string | undefined {
  const contact = asObject(value);
  const addresses = asObject(contact?.Addresses);
  const candidates = addresses?.ContactAddress;
  const first = Array.isArray(candidates) ? candidates[0] : candidates;
  const address = asObject(first);
  if (!address) return undefined;
  // State and country are vendor code/text variants. Street, city and postcode
  // form the cross-source comparable business-address evidence.
  const parts = [address.address1, address.address2, address.city, address.zip]
    .map(optionalText)
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? normalizedName(parts.join("|")) : undefined;
}

function stablePositiveInteger(value: string): number {
  if (/^\d+$/u.test(value)) {
    const number = Number(value);
    if (Number.isSafeInteger(number) && number > 0 && number <= 2_147_483_647) return number;
  }
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % 2_147_483_646 + 1;
}
