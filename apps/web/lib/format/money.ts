// Money formatting. CLAUDE.md §19/§29: money is stored as integer minor units
// (pence); we format ONLY at render, via Intl.NumberFormat. Never construct a
// float earlier in the pipeline.

const GBP = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' })

/**
 * Format an integer minor-unit amount as currency. Defaults to GBP; other
 * ISO-4217 currencies are formatted with a per-currency Intl instance.
 */
export function formatMoneyMinor(amountMinor: number, currency = 'GBP'): string {
  if (currency.toUpperCase() === 'GBP') {
    return GBP.format(amountMinor / 100)
  }
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amountMinor / 100)
}
