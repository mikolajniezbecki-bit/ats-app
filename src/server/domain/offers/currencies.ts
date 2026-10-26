// ISO 4217 currency codes accepted on offers (ats-project-scope.md §5.6, §7
// `offers`; task 35 Q9): a committed list instead of
// Intl.supportedValuesOf('currency'), which depends on the ICU build and
// includes non-tender codes. Active codes of ISO 4217 List One, without
// funds (e.g. BOV, CLF, MXV, USN), precious metals (XAU, XAG, XPD, XPT),
// SDR and testing codes (XDR, XSU, XUA, XBA–XBD, XTS, XXX). Keep it sorted.

export const CURRENCIES = [
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN",
  "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL",
  "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNY",
  "COP", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP",
  "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD",
  "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR",
  "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF",
  "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL",
  "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR",
  "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR",
  "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR",
  "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD",
  "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB",
  "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX",
  "USD", "UYU", "UZS", "VED", "VES", "VND", "VUV", "WST", "XAF", "XCD",
  "XCG", "XOF", "XPF", "YER", "ZAR", "ZMW", "ZWG",
] as const;

export type Currency = (typeof CURRENCIES)[number];

const SET: ReadonlySet<string> = new Set(CURRENCIES);

/** Exact, upper-case match only: `eur` and `EURO` are refused. */
export function isCurrency(code: string): code is Currency {
  return SET.has(code);
}
