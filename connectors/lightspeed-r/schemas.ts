import { z } from "zod";

const id = z.union([z.string().min(1), z.number().int()]);
const nullableId = id.nullable().optional();
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const timestamp = z.string().nullable().optional();

const relation = <T extends z.ZodTypeAny>(name: string, schema: T) => z.union([
  z.object({ [name]: z.union([schema, z.array(schema), z.literal("")]) }).passthrough(),
  z.literal(""),
]);

export const lightspeedShopSchema = z.object({
  shopID: id,
  name: z.string(),
  timeZone: z.string().optional(),
  archived: scalar.optional(),
  timeStamp: timestamp,
  Contact: z.unknown().optional(),
}).passthrough();

export const lightspeedEmployeeSchema = z.object({
  employeeID: id,
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  lockOut: scalar.optional(),
  archived: scalar.optional(),
  timeStamp: timestamp,
  Contact: z.unknown().optional(),
}).passthrough();

export const lightspeedCategorySchema = z.object({
  categoryID: id,
  name: z.string(),
  parentID: nullableId,
  nodeDepth: scalar.optional(),
  createTime: timestamp,
  timeStamp: timestamp,
}).passthrough();

export const lightspeedItemSchema = z.object({
  itemID: id,
  systemSku: scalar.optional(),
  description: z.string().optional(),
  categoryID: nullableId,
  defaultCost: scalar.optional(),
  archived: scalar.optional(),
  createTime: timestamp,
  timeStamp: timestamp,
}).passthrough();

export const lightspeedItemShopSchema = z.object({
  itemShopID: id,
  itemID: id,
  shopID: id,
  qoh: scalar.optional(),
  timeStamp: timestamp,
}).passthrough();

const lightspeedSaleLineSchema = z.object({
  saleLineID: id,
  itemID: nullableId,
  employeeID: nullableId,
  unitQuantity: scalar.optional(),
  unitPrice: scalar.optional(),
  normalUnitPrice: scalar.optional(),
  discountAmount: scalar.optional(),
  tax: scalar.optional(),
  avgCost: scalar.optional(),
  calcTotal: scalar.optional(),
  createTime: timestamp,
  timeStamp: timestamp,
}).passthrough();

const lightspeedSalePaymentSchema = z.object({
  salePaymentID: id,
  paymentTypeID: nullableId,
  amount: scalar.optional(),
  createTime: timestamp,
}).passthrough();

export const lightspeedSaleSchema = z.object({
  saleID: id,
  shopID: nullableId,
  employeeID: nullableId,
  registerID: nullableId,
  customerID: nullableId,
  completed: scalar.optional(),
  voided: scalar.optional(),
  archived: scalar.optional(),
  completeTime: timestamp,
  createTime: timestamp,
  updatetime: timestamp,
  updateTime: timestamp,
  timeStamp: timestamp,
  total: scalar.optional(),
  taxTotal: scalar.optional(),
  SaleLines: relation("SaleLine", lightspeedSaleLineSchema).optional(),
  SalePayments: relation("SalePayment", lightspeedSalePaymentSchema).optional(),
}).passthrough();

export const lightspeedCustomerSchema = z.object({
  customerID: id,
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  archived: scalar.optional(),
  createTime: timestamp,
  timeStamp: timestamp,
  Contact: z.unknown().optional(),
}).passthrough();

export const lightspeedVendorSchema = z.object({
  vendorID: id,
  name: z.string(),
  archived: scalar.optional(),
  accountNumber: scalar.optional(),
  priceLevel: scalar.optional(),
  updatePrice: scalar.optional(),
  updateCost: scalar.optional(),
  updateDescription: scalar.optional(),
  shareSellThrough: scalar.optional(),
  timeStamp: timestamp,
  b2bSellerUID: scalar.optional(),
  Contact: z.unknown().optional(),
  Reps: z.unknown().optional(),
  purchasingCurrency: z.unknown().optional(),
}).passthrough();

export const lightspeedOrderSchema = z.object({
  orderID: id,
  shopID: nullableId,
  vendorID: nullableId,
  createdByEmployeeID: nullableId,
  orderedDate: timestamp,
  receivedDate: timestamp,
  arrivalDate: timestamp,
  totalCost: scalar.optional(),
  createTime: timestamp,
  timeStamp: timestamp,
  refNum: z.string().optional(),
  OrderLines: z.unknown().optional(),
}).passthrough();

export const lightspeedOrderLineSchema = z.object({
  orderLineID: id,
  orderID: id,
  itemID: id,
  quantity: scalar.optional(),
  price: scalar.optional(),
  originalPrice: scalar.optional(),
  vendorCost: scalar.optional(),
  checkedIn: scalar.optional(),
  numReceived: scalar.optional(),
  total: scalar.optional(),
  createTime: timestamp,
  timeStamp: timestamp,
}).passthrough();

export const lightspeedPaymentTypeSchema = z.object({
  paymentTypeID: id,
  name: z.string(),
  archived: scalar.optional(),
}).passthrough();

export const lightspeedTaxCategorySchema = z.object({
  taxCategoryID: id,
  isTaxInclusive: scalar.optional(),
  tax1Name: z.string().optional(),
  tax2Name: z.string().optional(),
  tax1Rate: scalar.optional(),
  tax2Rate: scalar.optional(),
  timeStamp: timestamp,
}).passthrough();

export const lightspeedInventoryLogSchema = z.object({
  inventoryLogID: id,
  itemID: id,
  shopID: id,
  qohChange: scalar.optional(),
  costChange: scalar.optional(),
  createTime: timestamp,
  reason: z.string().optional(),
}).passthrough();

export const lightspeedSchemas = {
  shops: lightspeedShopSchema,
  employees: lightspeedEmployeeSchema,
  categories: lightspeedCategorySchema,
  items: lightspeedItemSchema,
  item_shops: lightspeedItemShopSchema,
  sales: lightspeedSaleSchema,
  customers: lightspeedCustomerSchema,
  vendors: lightspeedVendorSchema,
  orders: lightspeedOrderSchema,
  order_lines: lightspeedOrderLineSchema,
  payment_types: lightspeedPaymentTypeSchema,
  tax_categories: lightspeedTaxCategorySchema,
  inventory_logs: lightspeedInventoryLogSchema,
} as const;

export type LightspeedStreamId = keyof typeof lightspeedSchemas;
