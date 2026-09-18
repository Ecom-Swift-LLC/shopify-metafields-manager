'use strict';

const { OWNERS, DEFINITIONS_QUERY, ownerValuesQuery } = require('./queries');

const PAGE_SIZE = 100;

function assertOwnerType(ownerType) {
  if (!OWNERS[ownerType]) {
    throw new Error(`Unsupported owner type "${ownerType}". Use one of: ${Object.keys(OWNERS).join(', ')}.`);
  }
}

/** Every metafield definition for one owner type. */
async function fetchDefinitions(client, ownerType) {
  assertOwnerType(ownerType);
  const out = [];
  let after = null;
  for (;;) {
    const { data } = await client.request(DEFINITIONS_QUERY, { ownerType, first: PAGE_SIZE, after });
    for (const d of data.metafieldDefinitions.nodes) {
      out.push({
        id: d.id,
        name: d.name,
        namespace: d.namespace,
        key: d.key,
        type: d.type.name,
        metafieldsCount: d.metafieldsCount,
      });
    }
    const { hasNextPage, endCursor } = data.metafieldDefinitions.pageInfo;
    if (!hasNextPage) return out;
    after = endCursor;
  }
}

/**
 * Async generator over every owner (product, variant, collection, customer)
 * with its metafields. `namespace` narrows the metafields returned, `query`
 * is passed to the connection's search filter, `limit` caps owners.
 */
async function* fetchOwners(client, ownerType, { namespace, query, limit = Infinity } = {}) {
  assertOwnerType(ownerType);
  const owner = OWNERS[ownerType];
  const gql = ownerValuesQuery(ownerType);
  let after = null;
  let fetched = 0;

  while (fetched < limit) {
    const first = Math.min(PAGE_SIZE, limit - fetched);
    const { data } = await client.request(gql, {
      first,
      after,
      query: query || null,
      namespace: namespace || null,
    });
    const page = data[owner.root];
    for (const node of page.nodes) {
      yield {
        id: node.id,
        ...owner.pluck(node),
        metafields: (node.metafields?.nodes || []).map((m) => ({
          namespace: m.namespace,
          key: m.key,
          type: m.type,
          value: m.value,
        })),
      };
      fetched += 1;
      if (fetched >= limit) break;
    }
    if (!page.pageInfo.hasNextPage || fetched >= limit) break;
    after = page.pageInfo.endCursor;
  }
}

async function fetchAllOwners(client, ownerType, options) {
  const owners = [];
  for await (const o of fetchOwners(client, ownerType, options)) owners.push(o);
  return owners;
}

module.exports = { fetchDefinitions, fetchOwners, fetchAllOwners, assertOwnerType };
