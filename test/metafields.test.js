'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ShopifyGraphQLClient } = require('../src/graphql-client');
const { parseCsv, toCsv } = require('../src/csv');
const { fetchDefinitions, fetchAllOwners, assertOwnerType } = require('../src/fetch');
const { ownersToCsv } = require('../src/export');
const { prepareImport, runImport, chunk, BATCH_SIZE } = require('../src/import');
const { buildAudit, auditToMarkdown } = require('../src/audit');
const { ownerValuesQuery } = require('../src/queries');

function stubClient(responses) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const data = responses[i];
    i += 1;
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ data }) };
  };
  return { client: new ShopifyGraphQLClient({ shop: 't.myshopify.com', accessToken: 'x', fetchImpl }), calls };
}

const productNode = (n, metafields) => ({
  id: `gid://shopify/Product/${n}`,
  handle: `p-${n}`,
  title: `Product ${n}`,
  metafields: { nodes: metafields },
});

test('csv round-trips quotes, commas and newlines', () => {
  const rows = [{ a: 'plain', b: 'has, comma', c: 'line1\nline2 "quoted"' }];
  const parsed = parseCsv(toCsv(rows, ['a', 'b', 'c']));
  assert.deepEqual(parsed, rows);
});

test('parseCsv handles CRLF, BOM and blank trailing lines', () => {
  const parsed = parseCsv('﻿a,b\r\n1,2\r\n\r\n');
  assert.deepEqual(parsed, [{ a: '1', b: '2' }]);
});

test('parseCsv rejects an unterminated quote', () => {
  assert.throws(() => parseCsv('a\n"oops'), /unterminated/);
});

test('assertOwnerType rejects unknown owners', () => {
  assert.throws(() => assertOwnerType('ORDER'), /Unsupported owner type/);
});

test('ownerValuesQuery targets the right root connection per owner', () => {
  assert.match(ownerValuesQuery('PRODUCT'), /products\(first/);
  assert.match(ownerValuesQuery('PRODUCTVARIANT'), /productVariants\(first/);
  assert.match(ownerValuesQuery('CUSTOMER'), /customers\(first/);
});

test('fetchDefinitions follows pagination and flattens type', async () => {
  const def = (k) => ({ id: `gid://shopify/MetafieldDefinition/${k}`, name: k, namespace: 'custom', key: k, type: { name: 'single_line_text_field' }, metafieldsCount: 3 });
  const { client, calls } = stubClient([
    { metafieldDefinitions: { nodes: [def('a')], pageInfo: { hasNextPage: true, endCursor: 'c1' } } },
    { metafieldDefinitions: { nodes: [def('b')], pageInfo: { hasNextPage: false, endCursor: 'c2' } } },
  ]);
  const defs = await fetchDefinitions(client, 'PRODUCT');
  assert.deepEqual(defs.map((d) => d.key), ['a', 'b']);
  assert.equal(defs[0].type, 'single_line_text_field');
  assert.equal(calls[1].variables.after, 'c1');
});

test('fetchAllOwners paginates, passes namespace/query and respects limit', async () => {
  const { client, calls } = stubClient([
    { products: { nodes: [productNode(1, []), productNode(2, [])], pageInfo: { hasNextPage: true, endCursor: 'c2' } } },
    { products: { nodes: [productNode(3, [])], pageInfo: { hasNextPage: false, endCursor: 'c3' } } },
  ]);
  const owners = await fetchAllOwners(client, 'PRODUCT', { namespace: 'custom', query: 'status:active' });
  assert.equal(owners.length, 3);
  assert.equal(calls[0].variables.namespace, 'custom');
  assert.equal(calls[0].variables.query, 'status:active');

  const capped = stubClient([
    { products: { nodes: [productNode(1, []), productNode(2, [])], pageInfo: { hasNextPage: true, endCursor: 'c2' } } },
  ]);
  const two = await fetchAllOwners(capped.client, 'PRODUCT', { limit: 2 });
  assert.equal(two.length, 2);
  assert.equal(capped.calls.length, 1);
});

test('fetchAllOwners maps customers via their email', async () => {
  const { client } = stubClient([
    {
      customers: {
        nodes: [{ id: 'gid://shopify/Customer/9', displayName: 'Jane', defaultEmailAddress: { emailAddress: 'j@example.com' }, metafields: { nodes: [] } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  ]);
  const [c] = await fetchAllOwners(client, 'CUSTOMER');
  assert.equal(c.handle, 'j@example.com');
  assert.equal(c.label, 'Jane');
});

test('export CSV is one row per metafield and re-imports cleanly', () => {
  const csv = ownersToCsv([
    { id: 'gid://shopify/Product/1', handle: 'a', label: 'A', metafields: [{ namespace: 'custom', key: 'fabric', type: 'single_line_text_field', value: 'Cotton, 100%' }] },
  ]);
  assert.equal(parseCsv(csv).length, 1);
  const { inputs, problems } = prepareImport(csv, { ownerType: 'PRODUCT' });
  assert.equal(problems.length, 0);
  assert.deepEqual(inputs[0], { ownerId: 'gid://shopify/Product/1', namespace: 'custom', key: 'fabric', type: 'single_line_text_field', value: 'Cotton, 100%' });
});

test('prepareImport reports each kind of bad row with its CSV line', () => {
  const csv = [
    'ownerId,namespace,key,type,value',
    'gid://shopify/Product/1,custom,ok,single_line_text_field,fine',
    'not-a-gid,custom,k,single_line_text_field,v',
    'gid://shopify/Collection/2,custom,k,single_line_text_field,v',
    'gid://shopify/Product/3,custom,,single_line_text_field,v',
    'gid://shopify/Product/4,custom,k,single_line_text_field,',
    'gid://shopify/Product/1,custom,ok,single_line_text_field,again',
  ].join('\n');
  const { inputs, problems } = prepareImport(csv, { ownerType: 'PRODUCT' });
  assert.equal(inputs.length, 1);
  assert.deepEqual(problems.map((p) => p.line), [3, 4, 5, 6, 7]);
  assert.match(problems[0].message, /not a Shopify GID/);
  assert.match(problems[1].message, /Collection/);
  assert.match(problems[2].message, /missing key/);
  assert.match(problems[3].message, /empty value/);
  assert.match(problems[4].message, /duplicate/);
});

test('runImport batches 25 per call and dry-run sends nothing', async () => {
  const inputs = Array.from({ length: 60 }, (_, i) => ({ ownerId: `gid://shopify/Product/${i + 1}`, namespace: 'custom', key: 'k', type: 'single_line_text_field', value: 'v' }));
  assert.deepEqual(chunk(inputs, BATCH_SIZE).map((b) => b.length), [25, 25, 10]);

  const dry = await runImport(null, inputs, { dryRun: true });
  assert.equal(dry.batches, 3);
  assert.equal(dry.written, 0);

  const ok = (n) => ({ metafieldsSet: { metafields: Array.from({ length: n }, () => ({ namespace: 'custom', key: 'k' })), userErrors: [] } });
  const { client, calls } = stubClient([ok(25), ok(25), ok(10)]);
  const res = await runImport(client, inputs);
  assert.equal(calls.length, 3);
  assert.equal(res.written, 60);
  assert.equal(res.errors.length, 0);
});

test('runImport keeps going after a rejected batch and reports its errors', async () => {
  const inputs = Array.from({ length: 30 }, (_, i) => ({ ownerId: `gid://shopify/Product/${i + 1}`, namespace: 'custom', key: 'k', type: 'number_integer', value: '1' }));
  const { client } = stubClient([
    { metafieldsSet: { metafields: [], userErrors: [{ field: ['metafields', '3', 'value'], code: 'INVALID_VALUE', message: 'Value must be an integer.' }] } },
    { metafieldsSet: { metafields: Array.from({ length: 5 }, () => ({ namespace: 'custom', key: 'k' })), userErrors: [] } },
  ]);
  const res = await runImport(client, inputs);
  assert.equal(res.written, 5);
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].batch, 1);
  assert.equal(res.errors[0].code, 'INVALID_VALUE');
  assert.equal(res.errors[0].field, 'metafields.3.value');
});

test('buildAudit computes coverage, unused definitions and undefined metafields', () => {
  const definitions = [
    { namespace: 'custom', key: 'fabric', name: 'Fabric', type: 'single_line_text_field' },
    { namespace: 'custom', key: 'care', name: 'Care', type: 'multi_line_text_field' },
    { namespace: 'custom', key: 'legacy', name: 'Legacy', type: 'single_line_text_field' },
  ];
  const mf = (key, value = 'x') => ({ namespace: 'custom', key, type: 'single_line_text_field', value });
  const owners = [
    { id: 'gid://shopify/Product/1', handle: 'a', label: 'A', metafields: [mf('fabric'), mf('care'), mf('stray')] },
    { id: 'gid://shopify/Product/2', handle: 'b', label: 'B', metafields: [mf('fabric')] },
    { id: 'gid://shopify/Product/3', handle: 'c', label: 'C', metafields: [mf('care', '')] },
    { id: 'gid://shopify/Product/4', handle: 'd', label: 'D', metafields: [] },
  ];
  const report = buildAudit(definitions, owners);
  const byDef = Object.fromEntries(report.coverage.map((c) => [c.definition, c]));

  assert.equal(report.totalOwners, 4);
  assert.equal(byDef['custom.fabric'].filled, 2);
  assert.equal(byDef['custom.fabric'].coveragePct, 50);
  assert.equal(byDef['custom.care'].filled, 1);
  assert.equal(byDef['custom.care'].missingCount, 3); // empty value counts as missing
  assert.deepEqual(report.unusedDefinitions, ['custom.legacy']);
  assert.deepEqual(report.undefinedMetafields, [{ metafield: 'custom.stray', type: 'single_line_text_field', owners: 1 }]);

  const md = auditToMarkdown(report, 'PRODUCT');
  assert.match(md, /custom\.fabric/);
  assert.match(md, /Unused definitions/);
  assert.match(md, /Values without a definition/);
});

test('buildAudit handles an empty store without dividing by zero', () => {
  const report = buildAudit([{ namespace: 'custom', key: 'k', name: 'K', type: 't' }], []);
  assert.equal(report.coverage[0].coveragePct, 0);
});
