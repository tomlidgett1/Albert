-- Square Money.amount is expressed in the base (smallest) unit of its
-- Currency. Square's Currency enum corresponds to ISO 4217, whose official
-- Maintenance Agency publishes the decimal minor-unit relationship.
--
-- This function is deliberately an explicit intersection of:
--   * Square API 2026-07-15 Currency values; and
--   * SIX ISO 4217 List One, published 2026-01-01.
--
-- Sources:
--   https://developer.squareup.com/docs/build-basics/common-data-types/working-with-monetary-amounts
--   https://developer.squareup.com/reference/square/enums/Currency
--   https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml
--
-- Codes without an authoritative numeric minor-unit entry return NULL. That
-- includes UNKNOWN_CURRENCY, future values, historical currencies absent from
-- current List One, precious-metal/accounting/test codes, BTC and XUS. Curated
-- measures consequently fail closed instead of silently assuming two digits.

BEGIN;

CREATE OR REPLACE FUNCTION source_square.square_currency_exponent(currency_code text)
RETURNS smallint
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SECURITY INVOKER
AS $$
  SELECT CASE
    WHEN currency_code IN (
      'BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','UYI',
      'VND','VUV','XAF','XOF','XPF'
    ) THEN 0::smallint
    WHEN currency_code IN (
      'AED','AFN','ALL','AMD','AOA','ARS','AUD','AWG','AZN','BAM','BBD','BDT',
      'BMD','BND','BOB','BOV','BRL','BSD','BTN','BWP','BZD','CAD','CDF','CHE',
      'CHF','CHW','CNY','COP','COU','CRC','CUP','CVE','CZK','DKK','DOP','DZD',
      'EGP','ERN','ETB','EUR','FJD','FKP','GBP','GEL','GHS','GIP','GMD','GTQ',
      'GYD','HKD','HNL','HTG','HUF','IDR','ILS','INR','IRR','JMD','KES','KGS',
      'KHR','KPW','KYD','KZT','LAK','LBP','LKR','LRD','LSL','MAD','MDL','MGA',
      'MKD','MMK','MNT','MOP','MUR','MVR','MWK','MXN','MXV','MYR','MZN','NAD',
      'NGN','NIO','NOK','NPR','NZD','PAB','PEN','PGK','PHP','PKR','PLN','QAR',
      'RON','RSD','RUB','SAR','SBD','SCR','SDG','SEK','SGD','SHP','SLE','SOS',
      'SRD','SSP','SVC','SYP','SZL','THB','TJS','TMT','TOP','TRY','TTD','TWD',
      'TZS','UAH','USD','USN','UYU','UZS','WST','XCD','YER','ZAR','ZMW'
    ) THEN 2::smallint
    WHEN currency_code IN ('BHD','IQD','JOD','KWD','LYD','OMR','TND')
      THEN 3::smallint
    WHEN currency_code = 'CLF' THEN 4::smallint
    ELSE NULL::smallint
  END
$$;

REVOKE ALL ON FUNCTION source_square.square_currency_exponent(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION source_square.square_currency_exponent(text)
  TO transform_rw, diagnostic_ro, semantic_ro;

COMMENT ON FUNCTION source_square.square_currency_exponent(text) IS
  'Fail-closed Square Money base-unit exponent: explicit Square API 2026-07-15 and ISO 4217 List One 2026-01-01 intersection; NULL when no authoritative numeric minor unit is documented.';

COMMIT;
