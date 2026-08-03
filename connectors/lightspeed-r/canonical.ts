import { Decimal4, sumDecimal4 } from "../../packages/canonical-schema/src/index.js";
import { stagingColumnName } from "../../packages/connector-sdk/src/index.js";
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
export const mapLightspeedCanonical: CanonicalStreamMapper = (stream, row, context) => {
  assertStagingRow(stream, row);
  switch (stream) {
    case "shops": return mapShop(row, context);
    case "employees": return mapEmployee(row);
    case "categories": return mapCategory(row);
    case "items": return mapItem(row);
    case "item_shops": return mapItemShop(row, context);
    case "sales": return mapSale(row, context);
    case "customers": return mapCustomer(row);
    case "orders": return mapOrder(row, context);
    case "order_lines": return mapOrderLine(row, context);
    case "payment_types": return mapPaymentType(row);
    case "tax_categories": return mapTaxCategory(row);
    case "inventory_logs": return mapInventoryLog(row, context);
    default: throw new Error(`lightspeed_canonical_stream_unsupported:${stream}`);
  }
};

function mapShop(row: CanonicalStagingRow, context: CanonicalMappingContext): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.shop_id, "shops.shop_id");
  const name = requiredText(row.name, "shops.name");
  const active = !truthy(row.archived) && !row.tombstone;
  const address = contactAddress(row.contact);
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

function mapEmployee(row: CanonicalStagingRow): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.employee_id, "employees.employee_id");
  const displayName = composeDisplayName(row.first_name, row.last_name, `Employee ${id}`);
  const active = !truthy(row.archived) && !row.tombstone;
  const email = contactEmail(row.contact);
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
      corroboratingScope: scope ?? undefined,
    }),
  ];
}

function mapCategory(row: CanonicalStagingRow): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.category_id, "categories.category_id");
  const parentId = optionalIdentifier(row.parent_id);
  return [dimension("product_category", row.source_object_type, id, {
    parent_category_id: parentId
      ? sourceRef("product_category", "Category", parentId, row, { nullable: true })
      : null,
    name: requiredText(row.name, "categories.name"),
    active: !row.tombstone,
  }, row)];
}

function mapItem(row: CanonicalStagingRow): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.item_id, "items.item_id");
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
  const id = requiredIdentifier(row.item_shop_id, "item_shops.item_shop_id");
  const itemId = requiredIdentifier(row.item_id, "item_shops.item_id");
  const shopId = requiredIdentifier(row.shop_id, "item_shops.shop_id");
  const snapshotAt = requiredInstant(row.time_stamp ?? row.source_updated_at, "item_shops.time_stamp");
  const quantity = decimalOrZero(row.qoh, "item_shops.qoh");
  const unitCost = optionalDecimal(row.average_cost, "item_shops.average_cost");
  const stockValue = optionalDecimal(row.total_value_avg_cost, "item_shops.total_value_avg_cost")
    ?? (unitCost ? Decimal4.from(quantity).multiply(unitCost).toString() : null);
  return [fact("inventory_balance_snapshot", row.source_object_type, id, {
    product_variant_id: sourceRef("product_variant", "Item", itemId, row, { entityType: "product_variant" }),
    stock_location_id: sourceRef("stock_location", "Shop", shopId, row),
    snapshot_at: snapshotAt,
    snapshot_date: localCalendarDate(snapshotAt, context.timezone),
    quantity_on_hand: quantity,
    unit_cost: unitCost,
    stock_value: stockValue,
    currency: context.baseCurrency,
  }, "stock")];
}

type SaleLine = Readonly<{
  raw: JsonObject;
  sourceRecordId: string;
  parentSourceRecordId: string | null;
  index: number;
  quantity: Decimal4;
  unitPrice: Decimal4;
  normalUnitPrice: Decimal4;
  discount: Decimal4;
  netIncTax: Decimal4;
  unitCost: Decimal4 | null;
}>;

function mapSale(row: CanonicalStagingRow, context: CanonicalMappingContext): readonly CanonicalProjectionCommand[] {
  const saleId = requiredIdentifier(row.sale_id, "sales.sale_id");
  const shopId = requiredIdentifier(row.shop_id, "sales.shop_id");
  const orderedAt = requiredInstant(
    row.create_time ?? row.complete_time ?? row.time_stamp ?? row.source_updated_at,
    "sales.ordered_at",
  );
  const completedAt = optionalInstant(row.complete_time);
  const businessDate = tradingBusinessDate(completedAt ?? orderedAt, context);
  const voided = truthy(row.voided) || row.tombstone;
  const completed = truthy(row.completed);
  const rawLines = nestedRecords(row.sale_lines, "SaleLine");
  const lines = rawLines.map((raw, index): SaleLine => {
    const nativeId = optionalIdentifier(raw.saleLineID);
    const quantity = decimalOrZeroValue(raw.unitQuantity, `sales.sale_lines[${index}].unitQuantity`);
    const unitPrice = decimalOrZeroValue(raw.unitPrice, `sales.sale_lines[${index}].unitPrice`);
    const normalUnitPrice = optionalDecimalValue(
      raw.normalUnitPrice,
      `sales.sale_lines[${index}].normalUnitPrice`,
    ) ?? unitPrice;
    const rawDiscount = optionalDecimalValue(
      raw.discountAmount,
      `sales.sale_lines[${index}].discountAmount`,
    ) ?? ZERO;
    const discount = quantity.scaled < 0n ? negate(rawDiscount.abs()) : rawDiscount.abs();
    const calculated = optionalDecimalValue(raw.calcTotal, `sales.sale_lines[${index}].calcTotal`);
    return {
      raw,
      sourceRecordId: nativeId ?? `${saleId}#sale-line:${index + 1}`,
      parentSourceRecordId: optionalIdentifier(raw.parentSaleLineID),
      index,
      quantity,
      unitPrice,
      normalUnitPrice,
      discount,
      netIncTax: calculated ?? normalUnitPrice.multiply(quantity).subtract(discount),
      unitCost: optionalDecimalValue(raw.avgCost, `sales.sale_lines[${index}].avgCost`),
    };
  });
  const taxAllocations = saleLineTaxes(lines, decimalOrZeroValue(row.tax_total, "sales.tax_total"));
  const positiveLines = lines.filter((line) => line.quantity.scaled > 0n);
  const refundLines = lines.filter((line) => line.quantity.scaled < 0n);
  const orderStatus = voided
    ? "voided"
    : completed
      ? positiveLines.length === 0 && refundLines.length > 0 ? "refunded" : "completed"
      : "open";
  const channelObjectType = "LightspeedChannel";
  const channelRecordId = "in_store";
  const commands: CanonicalProjectionCommand[] = [
    dimension("channel", channelObjectType, channelRecordId, {
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

  const hasRefundLines = refundLines.length > 0;
  const positiveGross = sum(positiveLines.map((line) => line.normalUnitPrice.multiply(line.quantity)));
  const positiveDiscount = sum(positiveLines.map((line) => line.discount));
  const positiveNet = sum(positiveLines.map((line) => line.netIncTax));
  const positiveTax = sum(positiveLines.map((line) => taxAllocations[line.index] ?? ZERO));
  const sourceNet = optionalDecimalValue(row.total, "sales.total")
    ?? optionalDecimalValue(row.calc_total, "sales.calc_total")
    ?? positiveNet;
  const sourceDiscount = optionalDecimalValue(row.calc_discount, "sales.calc_discount") ?? positiveDiscount;
  const sourceTax = optionalDecimalValue(row.tax_total, "sales.tax_total") ?? positiveTax;
  const orderNet = hasRefundLines ? positiveNet : sourceNet;
  const orderDiscount = hasRefundLines ? positiveDiscount : sourceDiscount;
  const orderTax = hasRefundLines ? positiveTax : sourceTax;
  const orderGross = hasRefundLines
    ? positiveGross
    : sourceNet.add(sourceDiscount);
  const orderExTax = hasRefundLines
    ? orderNet.subtract(orderTax)
    : optionalDecimalValue(row.calc_subtotal, "sales.calc_subtotal") ?? orderNet.subtract(orderTax);
  const orderCost = hasRefundLines
    ? sumNullable(positiveLines.map((line) => line.unitCost?.multiply(line.quantity) ?? null))
    : optionalDecimal(row.calc_avg_cost, "sales.calc_avg_cost");
  commands.push(fact("commerce_order", row.source_object_type, saleId, {
    location_id: sourceRef("location", "Shop", shopId, row, { entityType: "location" }),
    register_id: registerId ? sourceRef("register", "Register", registerId, row) : null,
    channel_id: sourceRef("channel", channelObjectType, channelRecordId, row),
    customer_account_id: optionalEntityRef("customer_account", "Customer", row.customer_id, row, "customer_account"),
    worker_id: optionalEntityRef("worker", "Employee", row.employee_id, row, "worker"),
    ordered_at: orderedAt,
    completed_at: completedAt,
    fulfilled_at: completedAt,
    business_date: businessDate,
    status: orderStatus,
    voided,
    internal_transaction: false,
    gross_amount: orderGross.toString(),
    discount_amount: orderDiscount.toString(),
    net_amount_inc_tax: orderNet.toString(),
    tax_amount: orderTax.toString(),
    net_amount_ex_tax: orderExTax.toString(),
    total_cost: orderCost,
    currency: context.baseCurrency,
  }, "operational_sales", row.tombstone));

  for (const line of positiveLines) {
    const tax = taxAllocations[line.index] ?? ZERO;
    const itemId = optionalIdentifier(line.raw.itemID);
    const workerId = optionalIdentifier(line.raw.employeeID) ?? optionalIdentifier(row.employee_id);
    const taxCategoryId = optionalIdentifier(line.raw.taxCategoryID) ?? optionalIdentifier(row.tax_category_id);
    const lineOrderedAt = optionalInstant(line.raw.createTime) ?? orderedAt;
    commands.push(fact("commerce_order_line", "SaleLine", line.sourceRecordId, {
      order_id: sourceRef("commerce_order", row.source_object_type, saleId, row),
      line_number: line.index + 1,
      product_variant_id: itemId
        ? sourceRef("product_variant", "Item", itemId, row, { entityType: "product_variant", nullable: true })
        : null,
      location_id: sourceRef("location", "Shop", shopId, row, { entityType: "location" }),
      register_id: registerId ? sourceRef("register", "Register", registerId, row) : null,
      channel_id: sourceRef("channel", channelObjectType, channelRecordId, row),
      customer_account_id: optionalEntityRef("customer_account", "Customer", row.customer_id, row, "customer_account"),
      worker_id: workerId
        ? sourceRef("worker", "Employee", workerId, row, { entityType: "worker", nullable: true })
        : null,
      tax_code_id: taxCategoryId
        ? sourceRef("tax_code", "TaxCategory", taxCategoryId, row, { nullable: true })
        : null,
      ordered_at: lineOrderedAt,
      completed_at: completedAt,
      fulfilled_at: completedAt,
      business_date: businessDate,
      order_status: orderStatus,
      voided,
      internal_transaction: false,
      quantity: line.quantity.toString(),
      unit_price: line.unitPrice.toString(),
      unit_cost: line.unitCost?.toString() ?? null,
      gross_amount: line.normalUnitPrice.multiply(line.quantity).toString(),
      discount_amount: line.discount.toString(),
      net_amount_inc_tax: line.netIncTax.toString(),
      tax_amount: tax.toString(),
      net_amount_ex_tax: line.netIncTax.subtract(tax).toString(),
      total_cost: line.unitCost?.multiply(line.quantity).toString() ?? null,
      currency: context.baseCurrency,
    }, "operational_sales", row.tombstone));
  }

  for (const line of refundLines) {
    if (!line.parentSourceRecordId) {
      throw new Error(`lightspeed_refund_parent_missing:${saleId}:${line.sourceRecordId}`);
    }
    const tax = (taxAllocations[line.index] ?? ZERO).abs();
    const amount = line.netIncTax.abs();
    const itemId = optionalIdentifier(line.raw.itemID);
    const workerId = optionalIdentifier(line.raw.employeeID) ?? optionalIdentifier(row.employee_id);
    commands.push(fact("commerce_refund_line", "SaleLine", line.sourceRecordId, {
      original_order_line_id: sourceRef("commerce_order_line", "SaleLine", line.parentSourceRecordId, row),
      location_id: sourceRef("location", "Shop", shopId, row, { entityType: "location" }),
      product_variant_id: itemId
        ? sourceRef("product_variant", "Item", itemId, row, { entityType: "product_variant", nullable: true })
        : null,
      worker_id: workerId
        ? sourceRef("worker", "Employee", workerId, row, { entityType: "worker", nullable: true })
        : null,
      refunded_at: completedAt ?? requiredInstant(line.raw.timeStamp ?? orderedAt, "sales.refunded_at"),
      business_date: businessDate,
      quantity: line.quantity.abs().toString(),
      refund_amount_inc_tax: amount.toString(),
      tax_amount: tax.toString(),
      refund_amount_ex_tax: amount.subtract(tax).toString(),
      total_cost_reversed: line.unitCost?.multiply(line.quantity.abs()).toString() ?? null,
      currency: context.baseCurrency,
    }, "operational_sales"));
    commands.push({
      kind: "event_link",
      linkType: "reversal_of",
      from: { connectionId: row.connection_id, sourceObjectType: "SaleLine", sourceRecordId: line.sourceRecordId },
      to: { connectionId: row.connection_id, sourceObjectType: "SaleLine", sourceRecordId: line.parentSourceRecordId },
      evidence: { sale_id: saleId, quantity: line.quantity.toString(), amount: line.netIncTax.toString() },
    });
  }

  for (const [index, payment] of nestedRecords(row.sale_payments, "SalePayment").entries()) {
    const paymentId = optionalIdentifier(payment.salePaymentID) ?? `${saleId}#sale-payment:${index + 1}`;
    const amount = decimalOrZeroValue(payment.amount, `sales.sale_payments[${index}].amount`);
    const paidAt = optionalInstant(payment.createTime) ?? completedAt ?? orderedAt;
    commands.push(fact("commerce_payment", "SalePayment", paymentId, {
      order_id: sourceRef("commerce_order", row.source_object_type, saleId, row),
      location_id: sourceRef("location", "Shop", shopId, row, { entityType: "location" }),
      channel_id: sourceRef("channel", channelObjectType, channelRecordId, row),
      paid_at: paidAt,
      business_date: tradingBusinessDate(paidAt, context),
      tender_type: optionalIdentifier(payment.paymentTypeID) ?? "unknown",
      status: voided ? "voided" : amount.scaled < 0n ? "refunded" : "captured",
      amount: amount.toString(),
      currency: context.baseCurrency,
    }, "operational_sales", row.tombstone));
  }
  return commands;
}

function mapCustomer(row: CanonicalStagingRow): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.customer_id, "customers.customer_id");
  const name = optionalText(row.company)
    ?? composeDisplayName(row.first_name, row.last_name, `Customer ${id}`);
  const email = contactEmail(row.contact);
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

function mapOrder(row: CanonicalStagingRow, context: CanonicalMappingContext): readonly CanonicalProjectionCommand[] {
  const orderId = requiredIdentifier(row.order_id, "orders.order_id");
  const shopId = optionalIdentifier(row.shop_id);
  const supplierId = optionalIdentifier(row.vendor_id);
  const orderedAt = requiredInstant(
    row.ordered_date ?? row.create_time ?? row.time_stamp ?? row.source_updated_at,
    "orders.ordered_at",
  );
  const expectedAt = optionalInstant(row.arrival_date);
  const receivedAt = optionalInstant(row.received_date);
  const status = row.tombstone || truthy(row.archived)
    ? "cancelled"
    : truthy(row.complete) ? "completed" : receivedAt ? "partially_received" : "open";
  const lines = nestedRecords(row.order_lines, "OrderLine");
  if (lines.length === 0) {
    return [{
      kind: "metadata",
      sourceObjectType: row.source_object_type,
      sourceRecordId: orderId,
      classification: "lookup_only",
    }];
  }
  return lines.map((line, index) => {
    const lineId = optionalIdentifier(line.orderLineID) ?? `${orderId}#order-line:${index + 1}`;
    const quantity = decimalOrZeroValue(line.quantity, `orders.order_lines[${index}].quantity`);
    const received = optionalDecimalValue(line.numReceived, `orders.order_lines[${index}].numReceived`)
      ?? optionalDecimalValue(line.checkedIn, `orders.order_lines[${index}].checkedIn`)
      ?? (status === "completed" ? quantity : ZERO);
    const unitCost = optionalDecimalValue(
      line.vendorCost ?? line.price,
      `orders.order_lines[${index}].unit_cost`,
    );
    const totalCost = optionalDecimalValue(line.total, `orders.order_lines[${index}].total`)
      ?? unitCost?.multiply(quantity)
      ?? null;
    const itemId = optionalIdentifier(line.itemID);
    return fact("purchase_order_line", "OrderLine", lineId, {
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
      expected_at: expectedAt,
      received_at: receivedAt,
      business_date: localCalendarDate(orderedAt, context.timezone),
      status,
      ordered_quantity: quantity.toString(),
      received_quantity: received.toString(),
      unit_cost: unitCost?.toString() ?? null,
      total_cost: totalCost instanceof Decimal4 ? totalCost.toString() : totalCost,
      currency: optionalText(row.vendor_currency_code)?.toUpperCase() ?? context.baseCurrency,
    }, "product_master", row.tombstone);
  });
}

function mapOrderLine(row: CanonicalStagingRow, context: CanonicalMappingContext): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.order_line_id, "order_lines.order_line_id");
  const orderId = requiredIdentifier(row.order_id, "order_lines.order_id");
  const itemId = requiredIdentifier(row.item_id, "order_lines.item_id");
  const orderedAt = requiredInstant(
    row.create_time ?? row.time_stamp ?? row.source_updated_at,
    "order_lines.ordered_at",
  );
  const quantity = decimalOrZero(row.quantity, "order_lines.quantity");
  const received = optionalDecimal(row.num_received, "order_lines.num_received")
    ?? optionalDecimal(row.checked_in, "order_lines.checked_in")
    ?? "0.0000";
  const unitCost = optionalDecimal(row.vendor_cost ?? row.price, "order_lines.unit_cost");
  const totalCost = optionalDecimal(row.total, "order_lines.total")
    ?? (unitCost ? Decimal4.from(unitCost).multiply(quantity).toString() : null);
  const receivedAt = Decimal4.from(received).scaled > 0n
    ? optionalInstant(row.time_stamp ?? row.source_updated_at)
    : null;
  const status = row.tombstone
    ? "cancelled"
    : Decimal4.from(received).compare(quantity) >= 0 ? "completed"
      : Decimal4.from(received).scaled > 0n ? "partially_received" : "open";
  return [fact("purchase_order_line", row.source_object_type, id, {
    purchase_order_ref: orderId,
    line_number: stablePositiveInteger(id),
    supplier_id: null,
    product_variant_id: sourceRef("product_variant", "Item", itemId, row, {
      entityType: "product_variant",
      nullable: true,
    }),
    stock_location_id: null,
    ordered_at: orderedAt,
    expected_at: null,
    received_at: receivedAt,
    business_date: localCalendarDate(orderedAt, context.timezone),
    status,
    ordered_quantity: quantity,
    received_quantity: received,
    unit_cost: unitCost,
    total_cost: totalCost,
    currency: context.baseCurrency,
  }, "product_master", row.tombstone)];
}

function mapPaymentType(row: CanonicalStagingRow): readonly CanonicalProjectionCommand[] {
  return [{
    kind: "metadata",
    sourceObjectType: row.source_object_type,
    sourceRecordId: requiredIdentifier(row.payment_type_id, "payment_types.payment_type_id"),
    classification: "lookup_only",
  }];
}

function mapTaxCategory(row: CanonicalStagingRow): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.tax_category_id, "tax_categories.tax_category_id");
  const rate = decimalOrZero(row.tax1_rate, "tax_categories.tax1_rate");
  return [dimension("tax_code", row.source_object_type, id, {
    name: optionalText(row.tax1_name) ?? optionalText(row.tax2_name) ?? `Tax ${id}`,
    rate,
    input_or_output: "output",
  }, row)];
}

function mapInventoryLog(row: CanonicalStagingRow, context: CanonicalMappingContext): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.inventory_log_id, "inventory_logs.inventory_log_id");
  const itemId = requiredIdentifier(row.item_id, "inventory_logs.item_id");
  const shopId = requiredIdentifier(row.shop_id, "inventory_logs.shop_id");
  const occurredAt = requiredInstant(
    row.create_time ?? row.source_updated_at,
    "inventory_logs.create_time",
  );
  const quantity = decimalOrZero(row.qoh_change, "inventory_logs.qoh_change");
  const unitCost = optionalDecimal(row.cost_change, "inventory_logs.cost_change");
  return [fact("inventory_movement", row.source_object_type, id, {
    product_variant_id: sourceRef("product_variant", "Item", itemId, row, { entityType: "product_variant" }),
    stock_location_id: sourceRef("stock_location", "Shop", shopId, row),
    movement_type: inventoryMovementType(row.reason,truthy(row.automated)),
    occurred_at: occurredAt,
    business_date: tradingBusinessDate(occurredAt, context),
    quantity_delta: quantity,
    unit_cost: unitCost,
    total_cost: unitCost ? Decimal4.from(unitCost).multiply(quantity).toString() : null,
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

function nestedRecords(value: unknown, relationName: string): readonly JsonObject[] {
  if (value === null || value === undefined || value === "") return [];
  const container = asObject(value);
  const relation = container ? container[relationName] : value;
  if (relation === null || relation === undefined || relation === "") return [];
  const candidates = Array.isArray(relation) ? relation : [relation];
  return candidates.map((candidate, index) => {
    const record = asObject(candidate);
    if (!record) throw new Error(`lightspeed_canonical_nested_shape:${relationName}:${index}`);
    return record;
  });
}

function saleLineTaxes(lines: readonly SaleLine[], headerTax: Decimal4): readonly Decimal4[] {
  const explicit = lines.map((line) => {
    const first = optionalDecimalValue(line.raw.calcTax1, `sales.sale_lines[${line.index}].calcTax1`);
    const second = optionalDecimalValue(line.raw.calcTax2, `sales.sale_lines[${line.index}].calcTax2`);
    return first || second ? (first ?? ZERO).add(second ?? ZERO) : null;
  });
  if (explicit.every((value) => value !== null)) return explicit as readonly Decimal4[];
  return allocateSigned(headerTax, lines.map((line) => line.netIncTax));
}

function allocateSigned(total: Decimal4, weights: readonly Decimal4[]): readonly Decimal4[] {
  if (weights.length === 0) return [];
  const denominator = sum(weights);
  if (denominator.scaled === 0n) {
    return weights.map((_, index) => index === 0 ? total : ZERO);
  }
  let allocated = ZERO;
  return weights.map((weight, index) => {
    if (index === weights.length - 1) return total.subtract(allocated);
    const value = total.multiply(weight).divide(denominator);
    allocated = allocated.add(value);
    return value;
  });
}

function sum(values: readonly Decimal4[]): Decimal4 {
  return sumDecimal4(values);
}

function sumNullable(values: readonly (Decimal4 | null)[]): string | null {
  const present = values.filter((value): value is Decimal4 => value !== null);
  return present.length > 0 ? sum(present).toString() : null;
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
