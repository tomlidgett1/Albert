import { Decimal4, sumDecimal4 } from "../../packages/canonical-schema/src/index.js";
import { stagingColumnName } from "../../packages/connector-sdk/src/index.js";
import type {
  CanonicalEntityType,
  CanonicalMappingContext,
  CanonicalProjectionCommand,
  CanonicalProjectionTable,
  CanonicalProjectionValue,
  CanonicalSourceReference,
  CanonicalStagingRow,
  CanonicalStreamMapper,
} from "../../services/sync-workers/src/canonical-contract.js";
import { xeroManifest } from "./manifest.js";

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

/** Pure, fail-closed Xero typed-staging to source-neutral canonical projection. */
export const mapXeroCanonical: CanonicalStreamMapper = (stream, row, context) => {
  assertStagingRow(stream, row);
  switch (stream) {
    case "organisation": return mapOrganisation(row, context);
    case "accounts": return mapAccount(row);
    case "contacts": return mapContact(row);
    case "invoices": return mapInvoice(row, context, false);
    case "credit_notes": return mapInvoice(row, context, true);
    case "payments": return mapPayment(row);
    case "bank_transactions": return mapBankTransaction(row, context);
    case "manual_journals": return mapManualJournal(row, context);
    case "journals": return mapJournal(row, context);
    case "tax_rates": return mapTaxRate(row);
    case "tracking_categories": return mapTrackingCategory(row, context);
    default: throw new Error(`xero_canonical_stream_unsupported:${stream}`);
  }
};

function mapOrganisation(row: CanonicalStagingRow, context: CanonicalMappingContext): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.organisation_id, "organisation.organisation_id");
  return [dimension("legal_entity", row.source_object_type, id, {
    name: optionalText(row.legal_name) ?? requiredText(row.name, "organisation.name"),
    abn: optionalText(row.tax_number),
    base_currency: (optionalText(row.base_currency) ?? context.baseCurrency).toUpperCase(),
    active: !row.tombstone && normalizedStatus(row.organisation_status, "active") === "active",
  }, row)];
}

function mapAccount(row: CanonicalStagingRow): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.account_id, "accounts.account_id");
  const organisationId = requiredIdentifier(
    row.external_account_reference,
    "accounts.external_account_reference",
  );
  return [dimension("gl_account", row.source_object_type, id, {
    legal_entity_id: sourceRef("legal_entity", "Organisations", organisationId, row),
    code: optionalText(row.code) ?? id,
    name: requiredText(row.name, "accounts.name"),
    account_class: classifyXeroAccount(optionalText(row.type), optionalText(row.class)),
    active: !row.tombstone && normalizedStatus(row.status, "active") === "active",
  }, row)];
}

/**
 * Exhaustive crosswalk for the account types documented by Xero's AU chart of
 * accounts. Type is authoritative because Xero's broad EXPENSE class cannot
 * distinguish direct costs from operating expenses.
 */
export function classifyXeroAccount(type: string | null | undefined, accountClass: string | null | undefined): string {
  const normalizedType = type?.trim().toUpperCase();
  const byType: Readonly<Record<string, string>> = {
    BANK: "asset",
    CURRENT: "asset",
    FIXED: "asset",
    INVENTORY: "asset",
    NONCURRENT: "asset",
    PREPAYMENT: "asset",
    CURRLIAB: "liability",
    LIABILITY: "liability",
    TERMLIAB: "liability",
    EQUITY: "equity",
    REVENUE: "revenue",
    SALES: "revenue",
    OTHERINCOME: "revenue",
    DIRECTCOSTS: "cost_of_sales",
    DEPRECIATN: "operating_expense",
    EXPENSE: "operating_expense",
    OVERHEADS: "operating_expense",
  };
  if (normalizedType && byType[normalizedType]) return byType[normalizedType];

  const normalizedClass = accountClass?.trim().toUpperCase();
  const byClass: Readonly<Record<string, string>> = {
    ASSET: "asset",
    LIABILITY: "liability",
    EQUITY: "equity",
    REVENUE: "revenue",
    EXPENSE: "operating_expense",
  };
  return normalizedClass ? byClass[normalizedClass] ?? "unknown" : "unknown";
}

function mapContact(row: CanonicalStagingRow): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.contact_id, "contacts.contact_id");
  const composedName = [optionalText(row.first_name), optionalText(row.last_name)].filter(Boolean).join(" ");
  const name = optionalText(row.name) ?? (composedName || `Contact ${id}`);
  const active = !row.tombstone && normalizedStatus(row.contact_status, "active") === "active";
  const isCustomer = truthy(row.is_customer);
  const isSupplier = truthy(row.is_supplier);
  const hasNaturalName = Boolean(optionalText(row.first_name) || optionalText(row.last_name));
  const email = optionalText(row.email_address)?.toLowerCase() ?? undefined;
  const taxNumber = optionalText(row.tax_number) ?? undefined;
  const contactNumber = optionalText(row.contact_number) ?? undefined;
  const commands: CanonicalProjectionCommand[] = [];
  if (hasNaturalName) {
    commands.push(dimension("person", row.source_object_type, id, { display_name: name }, row));
  }
  if (isCustomer) {
    commands.push(
      dimension("customer_account", row.source_object_type, id, {
        person_id: hasNaturalName ? sourceRef("person", "Contacts", id, row) : null,
        display_name: name,
        first_order_at: null,
        last_order_at: null,
      }, row, "customer_account"),
      identityHint("customer_account", row.source_object_type, id, {
        externalId: contactNumber,
        deterministicKeys: { email, contact_number: contactNumber },
        normalizedName: normalizedName(name),
      }),
    );
  }
  if (isSupplier) {
    commands.push(
      dimension("supplier", row.source_object_type, id, {
        name,
        abn: taxNumber ?? null,
        active,
      }, row, "supplier"),
      identityHint("supplier", row.source_object_type, id, {
        externalId: contactNumber,
        deterministicKeys: { abn: taxNumber, email },
        normalizedName: normalizedName(name),
      }),
    );
  }
  if (commands.length === 0) {
    commands.push({
      kind: "metadata",
      sourceObjectType: row.source_object_type,
      sourceRecordId: id,
      classification: "identity_evidence",
    });
  }
  return commands;
}

function mapInvoice(
  row: CanonicalStagingRow,
  context: CanonicalMappingContext,
  creditNote: boolean,
): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(
    creditNote ? row.credit_note_id : row.invoice_id,
    creditNote ? "credit_notes.credit_note_id" : "invoices.invoice_id",
  );
  const organisationId = requiredIdentifier(
    row.external_account_reference,
    `${creditNote ? "credit_notes" : "invoices"}.external_account_reference`,
  );
  const issuedDate = requiredDate(row.date, `${creditNote ? "credit_notes" : "invoices"}.date`);
  const issuedAt = dateInstant(issuedDate);
  const contact = asObject(row.contact);
  const contactId = optionalIdentifier(contact?.ContactID);
  const type = requiredText(row.type, `${creditNote ? "credit_notes" : "invoices"}.type`).toUpperCase();
  const supplierBill = type.startsWith("ACCPAY");
  const invoiceType = supplierBill ? "supplier_bill" : "sales_invoice";
  const currency = (optionalText(row.currency_code) ?? context.baseCurrency).toUpperCase();
  const headerNet = decimalOrZeroValue(row.sub_total, "invoice.sub_total");
  const headerTax = decimalOrZeroValue(row.total_tax, "invoice.total_tax");
  const headerGross = optionalDecimalValue(row.total, "invoice.total") ?? headerNet.add(headerTax);
  const headerOutstanding = creditNote
    ? decimalOrZeroValue(row.remaining_credit, "credit_notes.remaining_credit")
    : decimalOrZeroValue(row.amount_due, "invoices.amount_due");
  const lineItems = jsonRecords(row.line_items);
  const effectiveLines = lineItems.length > 0 ? lineItems : [{
    LineAmount: headerNet.toString(),
    TaxAmount: headerTax.toString(),
    GrossAmount: headerGross.toString(),
  }];
  const rawNets = effectiveLines.map((line, index) =>
    decimalOrZeroValue(line.LineAmount, `invoice.line_items[${index}].LineAmount`));
  const rawTaxes = effectiveLines.map((line, index) =>
    optionalDecimalValue(line.TaxAmount, `invoice.line_items[${index}].TaxAmount`));
  const allocatedTax = rawTaxes.every((tax) => tax !== null)
    ? rawTaxes.map((tax) => tax ?? ZERO)
    : allocateByAbsoluteWeight(headerTax, rawNets);
  const rawGross = rawNets.map((net, index) =>
    optionalDecimalValue(effectiveLines[index]?.GrossAmount, `invoice.line_items[${index}].GrossAmount`)
      ?? net.add(allocatedTax[index] ?? ZERO));
  const outstanding = allocateByAbsoluteWeight(headerOutstanding, rawGross);
  const sign = creditNote ? -1 : 1;
  const status = row.tombstone ? "deleted" : financeStatus(row.status, "unknown");
  const dueAt = optionalDate(row.due_date);
  const paidAt = optionalDate(row.fully_paid_on_date);
  const commands: CanonicalProjectionCommand[] = effectiveLines.map((line, index) => {
    const sourceRecordId = optionalIdentifier(line.LineItemID) ?? `${id}#line-item:${index + 1}`;
    const quantity = optionalDecimalValue(line.Quantity, `invoice.line_items[${index}].Quantity`);
    const unitAmount = optionalDecimalValue(line.UnitAmount, `invoice.line_items[${index}].UnitAmount`);
    const net = signed(rawNets[index] ?? ZERO, sign);
    const tax = signed(allocatedTax[index] ?? ZERO, sign);
    const gross = signed(rawGross[index] ?? ZERO, sign);
    const outstandingAmount = signed(outstanding[index] ?? ZERO, sign);
    const account = glAccountRef(line, row, true);
    const taxType = optionalIdentifier(line.TaxType);
    const trackingOption = firstTrackingOption(line.Tracking);
    return fact("finance_invoice_line", creditNote ? "CreditNoteLine" : "InvoiceLine", sourceRecordId, {
      invoice_id: id,
      line_number: index + 1,
      invoice_type: invoiceType,
      legal_entity_id: sourceRef("legal_entity", "Organisations", organisationId, row),
      customer_account_id: !supplierBill && contactId
        ? sourceRef("customer_account", "Contacts", contactId, row, { entityType: "customer_account", nullable: true })
        : null,
      supplier_id: supplierBill && contactId
        ? sourceRef("supplier", "Contacts", contactId, row, { entityType: "supplier", nullable: true })
        : null,
      gl_account_id: account,
      tax_code_id: taxType ? sourceRef("tax_code", "TaxRates", taxType, row, { nullable: true }) : null,
      location_id: trackingOption
        ? sourceRef("location", "TrackingOptions", trackingOption, row, { entityType: "location", nullable: true })
        : null,
      issued_at: issuedAt,
      due_at: dueAt ? dateInstant(dueAt) : null,
      paid_at: paidAt ? dateInstant(paidAt) : null,
      business_date: issuedDate,
      status,
      quantity: quantity ? signed(quantity, sign).toString() : null,
      unit_amount: unitAmount?.toString() ?? null,
      net_amount_ex_tax: net.toString(),
      tax_amount: tax.toString(),
      net_amount_inc_tax: gross.toString(),
      outstanding_amount: outstandingAmount.toString(),
      currency,
    }, "statutory_finance", row.tombstone);
  });

  if (creditNote) {
    for (const [index, allocation] of jsonRecords(row.allocations).entries()) {
      const invoice = asObject(allocation.Invoice);
      const targetId = optionalIdentifier(invoice?.InvoiceID);
      if (!targetId) continue;
      commands.push({
        kind: "event_link",
        linkType: "reversal_of",
        from: { connectionId: row.connection_id, sourceObjectType: row.source_object_type, sourceRecordId: id },
        to: { connectionId: row.connection_id, sourceObjectType: "Invoices", sourceRecordId: targetId },
        evidence: {
          allocation_index: index + 1,
          amount: optionalDecimal(allocation.Amount, `credit_notes.allocations[${index}].Amount`) ?? "0.0000",
        },
      });
    }
  }
  return commands;
}

function mapPayment(row: CanonicalStagingRow): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.payment_id, "payments.payment_id");
  const invoiceId = optionalIdentifier(relationshipObject(row.invoice)?.InvoiceID);
  const creditNoteId = optionalIdentifier(relationshipObject(row.credit_note)?.CreditNoteID);
  const prepaymentId = optionalIdentifier(relationshipObject(row.prepayment)?.PrepaymentID);
  const overpaymentId = optionalIdentifier(relationshipObject(row.overpayment)?.OverpaymentID);
  const amount = decimalOrZero(row.amount, "payments.amount");
  const paidDate = requiredDate(row.date, "payments.date");
  const accountId = optionalIdentifier(relationshipObject(row.account)?.AccountID);
  const batchPaymentId = optionalIdentifier(row.batch_payment_id)
    ?? optionalIdentifier(relationshipObject(row.batch_payment)?.BatchPaymentID);
  const evidence = compactEvidence({
    amount,
    bank_amount: optionalDecimal(row.bank_amount, "payments.bank_amount"),
    paid_date: paidDate,
    status: normalizedStatus(row.status, "unknown"),
    payment_type: optionalText(row.payment_type),
    bank_account_id: accountId,
    reconciled: typeof row.is_reconciled === "boolean" ? row.is_reconciled : null,
    reference: optionalText(row.reference),
  });
  const commands: CanonicalProjectionCommand[] = [];
  const targets = [
    invoiceId ? { sourceObjectType: "Invoices", sourceRecordId: invoiceId } : null,
    creditNoteId ? { sourceObjectType: "CreditNotes", sourceRecordId: creditNoteId } : null,
    prepaymentId ? { sourceObjectType: "Prepayments", sourceRecordId: prepaymentId } : null,
    overpaymentId ? { sourceObjectType: "Overpayments", sourceRecordId: overpaymentId } : null,
  ].filter((target): target is Readonly<{ sourceObjectType: string; sourceRecordId: string }> => target !== null);
  if (targets.length > 1) {
    throw new Error(`xero_canonical_payment_target_ambiguous:${id}`);
  }
  const target = targets[0] ?? null;
  if (target) {
    commands.push({
      kind: "event_link",
      linkType: "settlement_of",
      from: { connectionId: row.connection_id, sourceObjectType: row.source_object_type, sourceRecordId: id },
      to: { connectionId: row.connection_id, ...target },
      evidence,
    });
  }
  if (batchPaymentId) {
    commands.push({
      kind: "event_link",
      linkType: "part_of_batch",
      from: { connectionId: row.connection_id, sourceObjectType: row.source_object_type, sourceRecordId: id },
      to: { connectionId: row.connection_id, sourceObjectType: "BatchPayments", sourceRecordId: batchPaymentId },
      evidence: compactEvidence({ amount, bank_amount: optionalDecimal(row.bank_amount, "payments.bank_amount") }),
    });
  }
  if (commands.length === 0) {
    commands.push({
      kind: "metadata",
      sourceObjectType: row.source_object_type,
      sourceRecordId: id,
      classification: "lookup_only",
    });
  }
  return commands;
}

function mapBankTransaction(row: CanonicalStagingRow, context: CanonicalMappingContext): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.bank_transaction_id, "bank_transactions.bank_transaction_id");
  const organisationId = requiredIdentifier(
    row.external_account_reference,
    "bank_transactions.external_account_reference",
  );
  const date = requiredDate(row.date, "bank_transactions.date");
  const type = requiredText(row.type, "bank_transactions.type").toUpperCase();
  const amount = decimalOrZeroValue(row.total, "bank_transactions.total");
  const direction = type.startsWith("RECEIVE")
    ? 1
    : type.startsWith("SPEND")
      ? -1
      : 0;
  if (direction===0) throw new Error(`xero_bank_transaction_type_invalid:${type}`);
  const signedAmount = signed(amount.abs(),direction);
  const bankAccount = asObject(row.bank_account);
  const glRef = bankAccount ? glAccountRef(bankAccount, row, true) : null;
  const lineItems = jsonRecords(row.line_items);
  const locationId = lineItems.map((line) => firstTrackingOption(line.Tracking)).find(Boolean);
  return [fact("finance_bank_transaction", row.source_object_type, id, {
    legal_entity_id: sourceRef("legal_entity", "Organisations", organisationId, row),
    gl_account_id: glRef,
    location_id: locationId
      ? sourceRef("location", "TrackingOptions", locationId, row, { entityType: "location", nullable: true })
      : null,
    transaction_at: dateInstant(date),
    posted_at: dateInstant(date),
    business_date: date,
    status: row.tombstone ? "deleted" : financeStatus(row.status, "unknown"),
    amount: signedAmount.toString(),
    tax_amount: signed(decimalOrZeroValue(row.total_tax, "bank_transactions.total_tax"), signedAmount.scaled < 0n ? -1 : 1).toString(),
    currency: (optionalText(row.currency_code) ?? context.baseCurrency).toUpperCase(),
  }, "cash_settlement", row.tombstone)];
}

function mapManualJournal(row: CanonicalStagingRow, context: CanonicalMappingContext): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.manual_journal_id, "manual_journals.manual_journal_id");
  const organisationId = requiredIdentifier(
    row.external_account_reference,
    "manual_journals.external_account_reference",
  );
  const date = requiredDate(row.date, "manual_journals.date");
  const lines = jsonRecords(row.journal_lines);
  if (lines.length === 0) {
    return [{ kind: "metadata", sourceObjectType: row.source_object_type, sourceRecordId: id, classification: "lookup_only" }];
  }
  return lines.map((line, index) => {
    const amount = decimalOrZeroValue(line.LineAmount, `manual_journals.journal_lines[${index}].LineAmount`);
    const tax = optionalDecimalValue(line.TaxAmount, `manual_journals.journal_lines[${index}].TaxAmount`) ?? ZERO;
    const taxType = optionalIdentifier(line.TaxType);
    const trackingOption = firstTrackingOption(line.Tracking);
    return fact("finance_journal_line", "ManualJournalLine", `${id}#journal-line:${index + 1}`, {
      journal_id: id,
      line_number: index + 1,
      legal_entity_id: sourceRef("legal_entity", "Organisations", organisationId, row),
      gl_account_id: requiredGlAccountRef(line, row, `manual_journals.journal_lines[${index}]`),
      tax_code_id: taxType ? sourceRef("tax_code", "TaxRates", taxType, row, { nullable: true }) : null,
      location_id: trackingOption
        ? sourceRef("location", "TrackingOptions", trackingOption, row, { entityType: "location", nullable: true })
        : null,
      posted_at: dateInstant(date),
      business_date: date,
      status: row.tombstone ? "deleted" : financeStatus(row.status, "posted"),
      debit_amount: amount.scaled > 0n ? amount.toString() : "0.0000",
      credit_amount: amount.scaled < 0n ? amount.abs().toString() : "0.0000",
      tax_amount: tax.toString(),
      currency: context.baseCurrency,
    }, "statutory_finance", row.tombstone);
  });
}

function mapJournal(row: CanonicalStagingRow, context: CanonicalMappingContext): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.journal_id, "journals.journal_id");
  const organisationId = requiredIdentifier(row.external_account_reference, "journals.external_account_reference");
  const date = requiredDate(row.journal_date, "journals.journal_date");
  const lines = jsonRecords(row.journal_lines);
  const commands: CanonicalProjectionCommand[] = lines.map((line, index) => {
    const amount = decimalOrZeroValue(line.NetAmount, `journals.journal_lines[${index}].NetAmount`);
    const tax = optionalDecimalValue(line.TaxAmount, `journals.journal_lines[${index}].TaxAmount`) ?? ZERO;
    const taxType = optionalIdentifier(line.TaxType);
    const trackingOption = firstTrackingOption(line.TrackingCategories ?? line.Tracking);
    const sourceRecordId = optionalIdentifier(line.JournalLineID) ?? `${id}#journal-line:${index + 1}`;
    return fact("finance_journal_line", "JournalLine", sourceRecordId, {
      journal_id: id,
      line_number: index + 1,
      legal_entity_id: sourceRef("legal_entity", "Organisations", organisationId, row),
      gl_account_id: requiredGlAccountRef(line, row, `journals.journal_lines[${index}]`),
      tax_code_id: taxType ? sourceRef("tax_code", "TaxRates", taxType, row, { nullable: true }) : null,
      location_id: trackingOption
        ? sourceRef("location", "TrackingOptions", trackingOption, row, { entityType: "location", nullable: true })
        : null,
      posted_at: dateInstant(date),
      business_date: date,
      status: row.tombstone ? "deleted" : "posted",
      debit_amount: amount.scaled > 0n ? amount.toString() : "0.0000",
      credit_amount: amount.scaled < 0n ? amount.abs().toString() : "0.0000",
      tax_amount: tax.toString(),
      currency: context.baseCurrency,
    }, "statutory_finance", row.tombstone);
  });
  const sourceId = optionalIdentifier(row.source_id);
  const sourceType = optionalText(row.source_type);
  if (sourceId && sourceType) {
    commands.push({
      kind: "event_link",
      linkType: "accounting_posting_of",
      from: { connectionId: row.connection_id, sourceObjectType: row.source_object_type, sourceRecordId: id },
      to: {
        connectionId: row.connection_id,
        sourceObjectType: xeroSourceObjectType(sourceType),
        sourceRecordId: sourceId,
      },
      evidence: compactEvidence({
        journal_number: numericScalar(row.journal_number),
        journal_date: date,
        source_type: sourceType,
      }),
    });
  }
  if (commands.length === 0) {
    commands.push({ kind: "metadata", sourceObjectType: row.source_object_type, sourceRecordId: id, classification: "lookup_only" });
  }
  return commands;
}

function mapTaxRate(row: CanonicalStagingRow): readonly CanonicalProjectionCommand[] {
  const id = requiredIdentifier(row.tax_type, "tax_rates.tax_type");
  const percent = optionalDecimalValue(row.effective_rate, "tax_rates.effective_rate")
    ?? optionalDecimalValue(row.display_tax_rate, "tax_rates.display_tax_rate")
    ?? ZERO;
  const upper = id.toUpperCase();
  const direction = upper.includes("INPUT")
    ? "input"
    : upper.includes("OUTPUT") ? "output" : upper === "NONE" ? "none" : "both";
  return [dimension("tax_code", row.source_object_type, id, {
    name: requiredText(row.name, "tax_rates.name"),
    rate: percent.divide("100").toString(),
    input_or_output: direction,
  }, row)];
}

function mapTrackingCategory(row: CanonicalStagingRow, context: CanonicalMappingContext): readonly CanonicalProjectionCommand[] {
  const categoryId = requiredIdentifier(row.tracking_category_id, "tracking_categories.tracking_category_id");
  const options = jsonRecords(row.options);
  const commands: CanonicalProjectionCommand[] = options.map((option, index) => {
    const id = optionalIdentifier(option.TrackingOptionID) ?? `${categoryId}#option:${index + 1}`;
    const name = requiredText(option.Name, `tracking_categories.options[${index}].Name`);
    const active = !row.tombstone && normalizedStatus(option.Status, "active") === "active";
    return dimension("location", "TrackingOptions", id, {
      name,
      timezone: context.timezone,
      legal_entity_id: sourceRef("legal_entity", "Organisations", row.external_account_reference, row, { nullable: true }),
      active,
    }, row, "location");
  });
  for (const [index, option] of options.entries()) {
    const id = optionalIdentifier(option.TrackingOptionID) ?? `${categoryId}#option:${index + 1}`;
    const name = requiredText(option.Name, `tracking_categories.options[${index}].Name`);
    commands.push(identityHint("location", "TrackingOptions", id, {
      externalId: id,
      deterministicKeys: { tracking_category: categoryId },
      normalizedName: normalizedName(name),
    }));
  }
  if (commands.length === 0) {
    commands.push({ kind: "metadata", sourceObjectType: row.source_object_type, sourceRecordId: categoryId, classification: "lookup_only" });
  }
  return commands;
}

function assertStagingRow(stream: string, row: CanonicalStagingRow): void {
  const contract = xeroManifest.streams.find((candidate) => candidate.id === stream);
  if (!contract) throw new Error(`xero_canonical_stream_unsupported:${stream}`);
  if (row.source_object_type !== contract.resource) {
    throw new Error(`xero_canonical_source_type_mismatch:${stream}:${row.source_object_type}`);
  }
  const coverage = xeroManifest.fieldCoverage.filter((field) => field.stream === stream);
  const allowed = new Set([...COMMON_STAGING_COLUMNS, ...coverage.map((field) => stagingColumnName(field.field))]);
  const drift = Object.keys(row).filter((column) => !allowed.has(column));
  if (drift.length > 0) throw new Error(`xero_canonical_staging_drift:${stream}:${drift.sort().join(",")}`);
  const stagedId = requiredIdentifier(row[stagingColumnName(contract.recordIdField)], `${stream}.record_id`);
  if (stagedId !== row.source_record_id) {
    throw new Error(`xero_canonical_source_id_mismatch:${stream}:${stagedId}:${row.source_record_id}`);
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
  authorityConcept: "statutory_finance" | "cash_settlement",
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
  sourceRecordId: unknown,
  row: CanonicalStagingRow,
  options: Readonly<{ entityType?: CanonicalEntityType; nullable?: boolean }> = {},
): CanonicalSourceReference {
  return {
    sourceRef: {
      table,
      sourceObjectType,
      sourceRecordId: requiredIdentifier(sourceRecordId, `${table}.source_record_id`),
      connectionId: row.connection_id,
      ...options,
    },
  };
}

function glAccountRef(
  value: JsonObject,
  row: CanonicalStagingRow,
  nullable: boolean,
): CanonicalSourceReference | null {
  const accountId = optionalIdentifier(value.AccountID);
  if (accountId) return sourceRef("gl_account", "Accounts", accountId, row, { nullable });
  const code = optionalText(value.AccountCode ?? value.Code);
  if (!code) return null;
  return {
    sourceRef: {
      table: "gl_account",
      sourceObjectType: "Accounts",
      connectionId: row.connection_id,
      nullable,
      lookup: { kind: "connector_natural_key", key: "gl_account_code", value: code },
    },
  };
}

function requiredGlAccountRef(value: JsonObject, row: CanonicalStagingRow, path: string): CanonicalSourceReference {
  const ref = glAccountRef(value, row, false);
  if (!ref) throw new Error(`xero_canonical_gl_account_missing:${path}`);
  return ref;
}

function jsonRecords(value: unknown): readonly JsonObject[] {
  if (value === null || value === undefined || value === "") return [];
  const candidates = Array.isArray(value) ? value : [value];
  return candidates.flatMap((candidate, index) => {
    if (candidate === null || candidate === undefined || (Array.isArray(candidate) && candidate.length === 0)) return [];
    const record = asObject(candidate);
    if (!record) throw new Error(`xero_canonical_json_shape:${index}`);
    return [record];
  });
}

function firstTrackingOption(value: unknown): string | null {
  for (const item of jsonRecords(value)) {
    const id = optionalIdentifier(item.TrackingOptionID);
    if (id) return id;
    const nested = asObject(item.Option);
    const nestedId = optionalIdentifier(nested?.TrackingOptionID);
    if (nestedId) return nestedId;
  }
  return null;
}

function allocateByAbsoluteWeight(total: Decimal4, weights: readonly Decimal4[]): readonly Decimal4[] {
  if (weights.length === 0) return [];
  const denominator = sumDecimal4(weights.map((weight) => weight.abs()));
  if (denominator.scaled === 0n) return weights.map((_, index) => index === 0 ? total : ZERO);
  let allocated = ZERO;
  return weights.map((weight, index) => {
    if (index === weights.length - 1) return total.subtract(allocated);
    const amount = total.multiply(weight.abs()).divide(denominator);
    allocated = allocated.add(amount);
    return amount;
  });
}

function signed(value: Decimal4, sign: -1 | 1): Decimal4 {
  return sign < 0 ? negate(value.abs()) : value;
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
    throw new Error(`xero_canonical_decimal_invalid:${path}`);
  }
  try {
    return Decimal4.from(typeof value === "bigint" ? value : String(value));
  } catch {
    throw new Error(`xero_canonical_decimal_invalid:${path}`);
  }
}

function requiredText(value: unknown, path: string): string {
  const text = optionalText(value);
  if (!text) throw new Error(`xero_canonical_text_missing:${path}`);
  return text;
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function requiredIdentifier(value: unknown, path: string): string {
  const id = optionalIdentifier(value);
  if (!id) throw new Error(`xero_canonical_id_missing:${path}`);
  return id;
}

function optionalIdentifier(value: unknown): string | null {
  const id = optionalText(value);
  return id && id !== "0" ? id : null;
}

function requiredDate(value: unknown, path: string): string {
  const date = optionalDate(value);
  if (!date) throw new Error(`xero_canonical_date_missing:${path}`);
  return date;
}

function optionalDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  const text = optionalText(value);
  if (!text) return null;
  const iso = /^(\d{4}-\d{2}-\d{2})/u.exec(text)?.[1];
  if (iso && !Number.isNaN(Date.parse(`${iso}T00:00:00Z`))) return iso;
  const xero = /^\/Date\(([-+]?\d+)(?:[+-]\d{4})?\)\/$/u.exec(text);
  if (xero) {
    const parsed = new Date(Number(xero[1]));
    return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString().slice(0, 10);
  }
  return null;
}

function dateInstant(value: string): string {
  return `${value}T00:00:00.000Z`;
}

function truthy(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return typeof value === "string" && ["1", "true", "yes", "active"].includes(value.trim().toLowerCase());
}

function normalizedStatus(value: unknown, fallback: string): string {
  return optionalText(value)?.toLowerCase() ?? fallback;
}

function financeStatus(value: unknown, fallback: string): string {
  const status = normalizedStatus(value, fallback);
  return new Set([
    "draft","submitted","authorised","paid","posted","reconciled",
    "voided","deleted","unknown",
  ]).has(status) ? status : "unknown";
}

function normalizedName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function relationshipObject(value: unknown): JsonObject | null {
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const record = asObject(candidate);
      if (record) return record;
    }
    return null;
  }
  return asObject(value);
}

function compactEvidence(values: Readonly<Record<string, string | number | boolean | null | undefined>>): Readonly<Record<string, string | number | boolean | null>> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined),
  );
}

function numericScalar(value: unknown): number | string | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return optionalText(value);
}

function xeroSourceObjectType(value: string): string {
  const normalized = value.replace(/[^A-Za-z]/gu, "").toUpperCase();
  const known: Readonly<Record<string, string>> = {
    MANUALJOURNAL: "ManualJournals",
    MANJOURNAL: "ManualJournals",
    ACCREC: "Invoices",
    ACCPAY: "Invoices",
    ACCRECCREDIT: "CreditNotes",
    ACCPAYCREDIT: "CreditNotes",
    ACCRECPAYMENT: "Payments",
    ACCPAYPAYMENT: "Payments",
    ARCREDITPAYMENT: "Payments",
    APCREDITPAYMENT: "Payments",
    CASHREC: "BankTransactions",
    CASHPAID: "BankTransactions",
  };
  return known[normalized] ?? value;
}
