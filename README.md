# shopify-metafields-manager

Export, bulk-import and audit Shopify metafields for products, variants, collections and customers from the Admin GraphQL API — one CLI, zero dependencies, no CSV app subscription.

We built this because every store we work on ends up with metafields half-filled: a `fabric` field on 60% of products, a `care_instructions` definition nobody uses, values sitting in a namespace with no definition at all. `smm` gives you the three things you need to fix that — a CSV export, a validated bulk import, and a coverage report that tells you exactly which records are missing what.

**Free audit for your own store while you're here:** [audit.ecomswiftllc.com](https://audit.ecomswiftllc.com/?utm_source=github&utm_medium=repo&utm_campaign=shopify-metafields-manager) checks SEO, speed, CRO and AI-visibility in one pass.

## Example

```
$ export SHOPIFY_STORE_DOMAIN=my-store.myshopify.com
$ export SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_xxx

$ smm audit --owner product --query "status:active"
# Metafield audit — PRODUCT

- PRODUCT records scanned: **212**
- Metafield definitions: **4**
- Definitions with no values anywhere: **1**
- Metafields in use with no definition: **1**

## Coverage by definition

| Definition | Type | Filled | Coverage | Missing |
| --- | --- | --- | --- | --- |
| `custom.fabric` | single_line_text_field | 131/212 | 61.8% | 81 |
| `custom.care_instructions` | multi_line_text_field | 74/212 | 34.9% | 138 |
| `custom.capacity_litres` | number_integer | 190/212 | 89.6% | 22 |
| `custom.legacy_size_guide` | single_line_text_field | 0/212 | 0% | 212 |

## Unused definitions

- `custom.legacy_size_guide`

## Values without a definition

| Metafield | Type | Records |
| --- | --- | --- |
| `custom.wash_temp` | single_line_text_field | 37 |
```

(Illustrative output — your numbers will differ.)

```
$ smm export --owner product --namespace custom --out product-metafields.csv
Wrote product-metafields.csv
Exported 395 metafield value(s) across 212 PRODUCT record(s).

$ smm import product-metafields.csv --owner product --dry-run
Dry run: 395 metafield value(s) in 16 batch(es) would be written. Nothing was sent.
```

## Features

- **Export to CSV or JSON**, one row per metafield value (`ownerId, handle, label, namespace, key, type, value`). The CSV is the same shape `import` reads, so export → edit in a spreadsheet → import is a round trip.
- **Bulk import with validation before the first write.** Every row is checked (real Shopify GID, matching resource type, namespace/key/type present, no empty values, no duplicates) and problems are reported by row number. If anything is wrong, nothing is sent.
- **`--dry-run`** shows how many values and batches would be written without touching the store.
- **Batching that matches the API.** `metafieldsSet` takes at most 25 metafields per call; `smm` batches for you and keeps going if one batch is rejected, reporting the userErrors for the batches that failed.
- **Coverage audit.** For every metafield definition: how many records have a value, the percentage, and which records are missing it. Also flags definitions that no record uses and metafields that have values but no definition.
- **Four owner types:** `product`, `variant`, `collection`, `customer`.
- **Cost-aware retry** on HTTP 429 and GraphQL `THROTTLED` errors, so a big export doesn't die halfway.
- **Zero runtime dependencies.** Node's built-in `fetch` and test runner only.
- **Usable as a library** — `fetchOwners` is an async generator you can stream into your own pipeline.

## Installation

```bash
npx shopify-metafields-manager --help
# or
npm install -g shopify-metafields-manager
```

The published npm package is not live yet; until it is, clone this repo and run `node bin/smm.js`, or `npm link` inside it to get the `smm` command.

Requires Node.js 18+.

### Getting an access token

1. In your store admin: **Settings → Apps and sales channels → Develop apps → Create an app.**
2. Under **Configuration → Admin API integration**, grant the read scopes for what you'll export (`read_products`, `read_customers`) and the matching write scopes if you'll import (`write_products`, `write_customers`). Collections use the product scopes.
3. Install the app and copy the **Admin API access token** (`shpat_...`).
4. Export it together with your store domain:

```bash
export SHOPIFY_STORE_DOMAIN=my-store.myshopify.com
export SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## Usage

```
smm definitions --owner <type>     List metafield definitions
smm export --owner <type>          Export metafield values to CSV/JSON
smm import <file.csv>              Write metafield values from a CSV
smm audit --owner <type>           Coverage report
```

| Flag | Applies to | Meaning |
| --- | --- | --- |
| `--owner <type>` | all (optional on `import`) | `product`, `variant`, `collection`, `customer` |
| `--namespace <ns>` | `export` | only metafields in this namespace |
| `--query <search>` | `export`, `audit` | Shopify search syntax, e.g. `status:active`, `tag:summer` |
| `--limit <n>` | `export`, `audit` | stop after n records |
| `--format <fmt>` | `definitions`, `export`, `audit` | `csv`/`json` (`md`/`json` for audit) |
| `--out <file>` | `definitions`, `export`, `audit` | write to a file instead of stdout |
| `--dry-run` | `import` | validate and count, send nothing |

```bash
# What definitions exist on products?
smm definitions --owner product

# Everything in the custom namespace, to a spreadsheet
smm export --owner product --namespace custom --out product-metafields.csv

# Which active products are missing which metafields?
smm audit --owner product --query "status:active" --format json --out audit.json

# Check a file, then write it
smm import product-metafields.csv --owner product --dry-run
smm import product-metafields.csv --owner product
```

A ready-to-edit CSV lives in [`examples/metafields-import.csv`](examples/metafields-import.csv). The `handle` and `label` columns are for humans; `import` only reads `ownerId`, `namespace`, `key`, `type` and `value`.

### As a library

```js
const { ShopifyGraphQLClient, fetchOwners, fetchDefinitions, buildAudit } = require('shopify-metafields-manager');

const client = new ShopifyGraphQLClient({
  shop: process.env.SHOPIFY_STORE_DOMAIN,
  accessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
});

const definitions = await fetchDefinitions(client, 'PRODUCT');
const owners = [];
for await (const product of fetchOwners(client, 'PRODUCT', { query: 'status:active' })) {
  owners.push(product);
}
console.log(buildAudit(definitions, owners).unusedDefinitions);
```

## What it does NOT do

- **It never deletes metafields.** Rows with an empty `value` are rejected, not treated as "delete this". Use the admin or `metafieldsDelete` directly for removals.
- **It does not create or edit metafield definitions.** `import` writes values with `metafieldsSet`; if a definition doesn't exist the value is still written (as an unstructured metafield), and if it does exist the `type` must match it or Shopify rejects that batch.
- **A rejected batch is rejected whole.** `metafieldsSet` is all-or-nothing per call, so one bad row fails its 25-row batch. `smm` reports the error and carries on with the rest; fix the row and re-run — values that already match are simply rewritten.
- **Audit reads at most 50 metafields per record.** The query asks for `metafields(first: 50)`. A record with more than 50 metafields will have the rest ignored by `audit` and `export`.
- **No orders, companies, locations or other owner types.** Only products, variants, collections and customers.
- **No file/reference resolution.** File-reference and metaobject-reference values are exported and imported as the raw GID string Shopify stores.
- **No metaobjects.** These are metafields on standard resources only.
- **The audit is a coverage count, not a data-quality check.** It tells you a value exists, not that it is correct.
- **Not run against a live store by us in CI.** The GraphQL operations were validated against the 2025-10 Admin schema and the 14 tests exercise the client, pagination, batching, and reports against stubbed responses. Try `--dry-run` and a development store first.

## FAQ

**Why not use the admin's built-in metafield editing or a CSV app?**
For a handful of products, the admin is fine. This is for when you need to edit hundreds of values in a spreadsheet, or find out which records are incomplete, without adding another app to the store.

**Can I round-trip an export?**
Yes. `export` produces the columns `import` expects. Edit the `value` column, delete rows you don't want to change, and import.

**What does a value look like for a list or a JSON metafield?**
Exactly as Shopify stores it: a JSON string such as `["red","blue"]` for `list.single_line_text_field`. Quote the cell in your spreadsheet if it contains commas — the CSV reader handles standard quoting.

**Will it hit the rate limit on a big catalog?**
Requests retry on HTTP 429 and `THROTTLED` errors with a backoff, so large exports take longer rather than fail.

Metafields are usually the first thing that breaks when a theme changes or a catalog is migrated. If you'd like a second pair of eyes on yours, our [free Shopify tools](https://www.ecomswiftllc.com/free-tools) and the [store audit](https://audit.ecomswiftllc.com/?utm_source=github&utm_medium=repo&utm_campaign=shopify-metafields-manager) are a good starting point.

## Related Shopify tools

- [`shopify-order-export-cli`](https://github.com/Ecom-Swift-LLC/shopify-order-export-cli) — export Shopify orders to CSV/JSON and get a revenue and customer report.
- [`shopify-store-audit-toolkit`](https://github.com/EcomswiftLLC/shopify-store-audit-toolkit) — CLI that audits a live store's SEO, structured data and performance signals.
- [`shopify-webhook-toolkit`](https://github.com/EcomswiftLLC/shopify-webhook-toolkit) — verify, log and replay Shopify webhooks locally.
- [`shopify-theme-deploy-action`](https://github.com/Ecom-Swift-LLC/shopify-theme-deploy-action) — CI deploys and per-PR preview themes.
- [`shopify-audit-mcp`](https://github.com/EcomswiftLLC/shopify-audit-mcp) — the same audit as a tool for Claude, Cursor and other MCP clients.

## Contributing

Issues and PRs welcome — especially more owner types (orders, companies, locations), a `--delete` mode behind an explicit confirmation flag, and definition creation from a CSV.

## Roadmap

- Optional `metafieldsDelete` support behind a confirmation flag.
- Export/import for metafield definitions themselves.
- A `--diff` mode for `import` that compares the CSV to current values before writing.

## License

MIT © Ecom Swift LLC

## Need help?

This project is maintained by **Ecom Swift LLC**, a Shopify Partner.

- 🛍️ Shopify Partner Directory: https://www.shopify.com/partners/directory/partner/waowy
- ✉️ Email: support@ecomswiftllc.com
- 💬 WhatsApp: https://wa.me/16312511767

---

Want someone to clean up your catalog data? [Get a free store audit](https://audit.ecomswiftllc.com/?utm_source=github&utm_medium=repo&utm_campaign=shopify-metafields-manager) (SEO, speed, CRO, AI visibility) or browse our other [free Shopify tools](https://www.ecomswiftllc.com/free-tools). We're **Ecom Swift LLC**, a Shopify Partner Agency — [www.ecomswiftllc.com](https://www.ecomswiftllc.com).
