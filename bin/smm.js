#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  ShopifyGraphQLClient,
  ShopifyGraphQLError,
  OWNER_TYPES,
  fetchDefinitions,
  fetchAllOwners,
  ownersToCsv,
  prepareImport,
  runImport,
  buildAudit,
  auditToMarkdown,
  toCsv,
} = require('../src/index');

const HELP = `smm — Shopify metafields manager

Usage:
  smm definitions --owner <type>            List metafield definitions
  smm export --owner <type>                 Export metafield values to CSV/JSON
  smm import <file.csv>                     Write metafield values from a CSV
  smm audit --owner <type>                  Coverage report: which records are missing which metafields
  smm --help | --version

Owner types: ${OWNER_TYPES.join(', ')}   (case-insensitive; "product", "variant", "collection", "customer" also accepted)

Auth (env vars, or the equivalent flags):
  SHOPIFY_STORE_DOMAIN         e.g. my-store.myshopify.com   (--shop)
  SHOPIFY_ADMIN_ACCESS_TOKEN   Admin API access token        (--access-token)
  SHOPIFY_API_VERSION          optional, defaults to 2025-10 (--api-version)

Options:
  --namespace <ns>     export: only this namespace
  --query <search>     export/audit: Shopify search syntax, e.g. "status:active" or "tag:summer"
  --limit <n>          stop after n records
  --format <fmt>       definitions: csv|json (default csv)   export: csv|json (default csv)
                       audit: md|json (default md)
  --out <file>         write to a file instead of stdout
  --owner <type>       import: optional; rejects rows whose ownerId is a different resource type
  --dry-run            import: validate and show what would be written, send nothing

Examples:
  smm export --owner product --namespace custom --out product-metafields.csv
  smm audit --owner product --query "status:active"
  smm import product-metafields.csv --dry-run
`;

const OWNER_ALIASES = {
  PRODUCT: 'PRODUCT',
  PRODUCTS: 'PRODUCT',
  VARIANT: 'PRODUCTVARIANT',
  PRODUCTVARIANT: 'PRODUCTVARIANT',
  COLLECTION: 'COLLECTION',
  COLLECTIONS: 'COLLECTION',
  CUSTOMER: 'CUSTOMER',
  CUSTOMERS: 'CUSTOMER',
};

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      options[key] = true;
    } else {
      options[key] = next;
      i += 1;
    }
  }
  return { command, options, positional };
}

function resolveOwner(options, { required }) {
  if (!options.owner || options.owner === true) {
    if (required) throw new Error(`--owner is required. Use one of: ${OWNER_TYPES.join(', ')}.`);
    return undefined;
  }
  const owner = OWNER_ALIASES[String(options.owner).toUpperCase()];
  if (!owner) throw new Error(`Unknown --owner "${options.owner}". Use one of: ${OWNER_TYPES.join(', ')}.`);
  return owner;
}

function resolveClient(options) {
  const shop = options.shop || process.env.SHOPIFY_STORE_DOMAIN;
  const accessToken = options.accessToken || process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  const apiVersion = options.apiVersion || process.env.SHOPIFY_API_VERSION || undefined;
  if (!shop || !accessToken) {
    throw new Error(
      'Missing credentials. Set SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN ' +
        '(or pass --shop / --access-token). See README "Getting an access token".'
    );
  }
  return new ShopifyGraphQLClient({ shop, accessToken, apiVersion });
}

function writeOutput(content, outPath) {
  if (outPath && typeof outPath === 'string') {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, content);
    process.stderr.write(`Wrote ${outPath}\n`);
  } else {
    process.stdout.write(content);
  }
}

function numeric(value) {
  if (value === undefined || value === true) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function str(value) {
  return typeof value === 'string' ? value : undefined;
}

async function runDefinitions(options) {
  const owner = resolveOwner(options, { required: true });
  const defs = await fetchDefinitions(resolveClient(options), owner);
  const format = options.format || 'csv';
  if (format === 'json') {
    writeOutput(JSON.stringify(defs, null, 2) + '\n', options.out);
  } else if (format === 'csv') {
    writeOutput(toCsv(defs, ['namespace', 'key', 'name', 'type', 'metafieldsCount', 'id']), options.out);
  } else {
    throw new Error(`Unknown --format "${format}". Use csv or json.`);
  }
  process.stderr.write(`${defs.length} definition(s).\n`);
}

async function runExport(options) {
  const owner = resolveOwner(options, { required: true });
  const owners = await fetchAllOwners(resolveClient(options), owner, {
    namespace: str(options.namespace),
    query: str(options.query),
    limit: numeric(options.limit),
  });
  const format = options.format || 'csv';
  if (format === 'json') {
    writeOutput(JSON.stringify(owners, null, 2) + '\n', options.out);
  } else if (format === 'csv') {
    writeOutput(ownersToCsv(owners), options.out);
  } else {
    throw new Error(`Unknown --format "${format}". Use csv or json.`);
  }
  const values = owners.reduce((n, o) => n + o.metafields.length, 0);
  process.stderr.write(`Exported ${values} metafield value(s) across ${owners.length} ${owner} record(s).\n`);
}

async function runAudit(options) {
  const owner = resolveOwner(options, { required: true });
  const client = resolveClient(options);
  const definitions = await fetchDefinitions(client, owner);
  const owners = await fetchAllOwners(client, owner, {
    query: str(options.query),
    limit: numeric(options.limit),
  });
  const report = buildAudit(definitions, owners);
  const format = options.format || 'md';
  if (format === 'json') {
    writeOutput(JSON.stringify(report, null, 2) + '\n', options.out);
  } else if (format === 'md') {
    writeOutput(auditToMarkdown(report, owner) + '\n', options.out);
  } else {
    throw new Error(`Unknown --format "${format}". Use md or json.`);
  }
}

async function runImportCommand(options, positional) {
  const file = positional[0];
  if (!file) throw new Error('import needs a CSV file: smm import <file.csv>');
  const owner = resolveOwner(options, { required: false });
  const { inputs, problems } = prepareImport(fs.readFileSync(file, 'utf8'), { ownerType: owner });

  if (problems.length) {
    process.stderr.write(`${problems.length} problem(s) in ${file}; nothing was sent:\n`);
    for (const p of problems.slice(0, 50)) process.stderr.write(`  row ${p.line}: ${p.message}\n`);
    if (problems.length > 50) process.stderr.write(`  ...and ${problems.length - 50} more\n`);
    process.exitCode = 1;
    return;
  }

  const dryRun = Boolean(options.dryRun);
  const client = dryRun ? null : resolveClient(options);
  const result = await runImport(client, inputs, { dryRun });

  if (dryRun) {
    process.stdout.write(`Dry run: ${result.attempted} metafield value(s) in ${result.batches} batch(es) would be written. Nothing was sent.\n`);
    return;
  }
  process.stdout.write(`Wrote ${result.written} of ${result.attempted} metafield value(s) in ${result.batches} batch(es).\n`);
  if (result.errors.length) {
    process.stderr.write(`${result.errors.length} error(s) — each failing batch was rejected as a whole:\n`);
    for (const e of result.errors) process.stderr.write(`  batch ${e.batch}: ${e.code || 'ERROR'} ${e.field} — ${e.message}\n`);
    process.exitCode = 1;
  }
}

async function main() {
  const { command, options, positional } = parseArgs(process.argv.slice(2));

  if (!command || options.help || command === '--help' || command === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (command === '--version') {
    process.stdout.write(require('../package.json').version + '\n');
    return;
  }

  if (command === 'definitions') return runDefinitions(options);
  if (command === 'export') return runExport(options);
  if (command === 'audit') return runAudit(options);
  if (command === 'import') return runImportCommand(options, positional);

  process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(err instanceof ShopifyGraphQLError ? `Admin API error: ${err.message}\n` : `Error: ${err.message}\n`);
  process.exitCode = 1;
});
