'use strict';

const { parseCsv } = require('./csv');
const { METAFIELDS_SET_MUTATION } = require('./queries');

// metafieldsSet accepts at most 25 metafields per call.
const BATCH_SIZE = 25;
const GID_RE = /^gid:\/\/shopify\/([A-Za-z]+)\/\d+$/;
const GID_TYPE_FOR_OWNER = {
  PRODUCT: 'Product',
  PRODUCTVARIANT: 'ProductVariant',
  COLLECTION: 'Collection',
  CUSTOMER: 'Customer',
};

/**
 * Validates CSV text and returns { inputs, problems }. Nothing is sent to
 * Shopify here, so a bad file is caught before the first write.
 * `problems` entries are { line, message } where line is the CSV row number (header = 1).
 */
function prepareImport(csvText, { ownerType } = {}) {
  const rows = parseCsv(csvText);
  const inputs = [];
  const problems = [];
  const seen = new Set();
  const expectedGid = ownerType ? GID_TYPE_FOR_OWNER[ownerType] : null;

  rows.forEach((row, idx) => {
    const line = idx + 2;
    const missing = ['ownerId', 'namespace', 'key', 'type'].filter((c) => !String(row[c] || '').trim());
    if (missing.length) {
      problems.push({ line, message: `missing ${missing.join(', ')}` });
      return;
    }
    const ownerId = row.ownerId.trim();
    const gid = GID_RE.exec(ownerId);
    if (!gid) {
      problems.push({ line, message: `ownerId "${ownerId}" is not a Shopify GID (gid://shopify/Product/123)` });
      return;
    }
    if (expectedGid && gid[1] !== expectedGid) {
      problems.push({ line, message: `ownerId is a ${gid[1]}, but --owner expects ${expectedGid}` });
      return;
    }
    if (row.value === undefined || row.value === '') {
      problems.push({ line, message: 'empty value (this tool does not delete metafields)' });
      return;
    }
    const namespace = row.namespace.trim();
    const key = row.key.trim();
    const dedupeKey = `${ownerId}|${namespace}|${key}`;
    if (seen.has(dedupeKey)) {
      problems.push({ line, message: `duplicate ${namespace}.${key} for ${ownerId}` });
      return;
    }
    seen.add(dedupeKey);
    inputs.push({ ownerId, namespace, key, type: row.type.trim(), value: row.value });
  });

  return { inputs, problems };
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Writes prepared inputs with metafieldsSet, 25 per call. A userError in one
 * batch does not stop the others; failures come back in `errors`.
 */
async function runImport(client, inputs, { dryRun = false } = {}) {
  const batches = chunk(inputs, BATCH_SIZE);
  if (dryRun) return { attempted: inputs.length, written: 0, batches: batches.length, errors: [], dryRun: true };

  let written = 0;
  const errors = [];
  for (const [i, batch] of batches.entries()) {
    const { data } = await client.request(METAFIELDS_SET_MUTATION, { metafields: batch });
    const result = data.metafieldsSet;
    if (result.userErrors && result.userErrors.length) {
      // metafieldsSet is atomic per call: any userError means none of that batch was written.
      for (const e of result.userErrors) {
        errors.push({ batch: i + 1, field: (e.field || []).join('.'), code: e.code, message: e.message });
      }
    } else {
      written += result.metafields.length;
    }
  }
  return { attempted: inputs.length, written, batches: batches.length, errors, dryRun: false };
}

module.exports = { prepareImport, runImport, chunk, BATCH_SIZE };
