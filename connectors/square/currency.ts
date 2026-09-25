/**
 * Square Money.amount is an integer count of the currency's base unit.
 *
 * Keep this allowlist aligned with:
 *   - Square API 2026-07-15 Currency enum; and
 *   - SIX ISO 4217 List One, published 2026-01-01.
 *
 * Only codes present in both sources with an authoritative numeric minor unit
 * are classified. Historical currencies, precious-metal/accounting/test
 * codes, BTC, XUS, UNKNOWN_CURRENCY, and future Square enum values deliberately
 * return null. Callers must fail closed rather than assume two decimal places.
 *
 * Sources:
 * https://developer.squareup.com/docs/build-basics/common-data-types/working-with-monetary-amounts
 * https://developer.squareup.com/reference/square/enums/Currency
 * https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml
 */

export type SquareCurrencyExponent = 0 | 2 | 3 | 4;

export const SQUARE_CURRENCY_EXPONENT_0 = Object.freeze([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI",
  "VND", "VUV", "XAF", "XOF", "XPF",
] as const);

export const SQUARE_CURRENCY_EXPONENT_2 = Object.freeze([
  "AED", "AFN", "ALL", "AMD", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT",
  "BMD", "BND", "BOB", "BOV", "BRL", "BSD", "BTN", "BWP", "BZD", "CAD", "CDF", "CHE",
  "CHF", "CHW", "CNY", "COP", "COU", "CRC", "CUP", "CVE", "CZK", "DKK", "DOP", "DZD",
  "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GTQ",
  "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IRR", "JMD", "KES", "KGS",
  "KHR", "KPW", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "MAD", "MDL", "MGA",
  "MKD", "MMK", "MNT", "MOP", "MUR", "MVR", "MWK", "MXN", "MXV", "MYR", "MZN", "NAD",
  "NGN", "NIO", "NOK", "NPR", "NZD", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "QAR",
  "RON", "RSD", "RUB", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SOS",
  "SRD", "SSP", "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TOP", "TRY", "TTD", "TWD",
  "TZS", "UAH", "USD", "USN", "UYU", "UZS", "WST", "XCD", "YER", "ZAR", "ZMW",
] as const);

export const SQUARE_CURRENCY_EXPONENT_3 = Object.freeze([
  "BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND",
] as const);

export const SQUARE_CURRENCY_EXPONENT_4 = Object.freeze(["CLF"] as const);

const EXPONENT_BY_CURRENCY = new Map<string, SquareCurrencyExponent>([
  ...SQUARE_CURRENCY_EXPONENT_0.map((currency) => [currency, 0] as const),
  ...SQUARE_CURRENCY_EXPONENT_2.map((currency) => [currency, 2] as const),
  ...SQUARE_CURRENCY_EXPONENT_3.map((currency) => [currency, 3] as const),
  ...SQUARE_CURRENCY_EXPONENT_4.map((currency) => [currency, 4] as const),
]);

/** Return null when a Square currency lacks current, numeric ISO minor units. */
export function squareCurrencyExponent(currency: string): SquareCurrencyExponent | null {
  return EXPONENT_BY_CURRENCY.get(currency) ?? null;
}
