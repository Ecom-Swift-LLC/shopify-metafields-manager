'use strict';

// Owner types the tool can read and write. `root` is the top-level
// Admin GraphQL connection, `label` is the extra selection used to give each
// row a human-readable identifier in exports and reports.
const OWNERS = {
  PRODUCT: { root: 'products', label: 'handle title', pluck: (n) => ({ handle: n.handle, label: n.title }) },
  PRODUCTVARIANT: { root: 'productVariants', label: 'sku displayName', pluck: (n) => ({ handle: n.sku || '', label: n.displayName }) },
  COLLECTION: { root: 'collections', label: 'handle title', pluck: (n) => ({ handle: n.handle, label: n.title }) },
  CUSTOMER: { root: 'customers', label: 'displayName defaultEmailAddress { emailAddress }', pluck: (n) => ({ handle: n.defaultEmailAddress?.emailAddress || '', label: n.displayName }) },
};

const DEFINITIONS_QUERY = `#graphql
  query MetafieldDefinitions($ownerType: MetafieldOwnerType!, $first: Int!, $after: String) {
    metafieldDefinitions(ownerType: $ownerType, first: $first, after: $after) {
      nodes {
        id
        name
        namespace
        key
        type { name }
        metafieldsCount
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

function ownerValuesQuery(ownerType) {
  const owner = OWNERS[ownerType];
  return `#graphql
  query OwnerMetafields($first: Int!, $after: String, $query: String, $namespace: String) {
    ${owner.root}(first: $first, after: $after, query: $query) {
      nodes {
        id
        ${owner.label}
        metafields(first: 50, namespace: $namespace) {
          nodes { namespace key type value }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
}

const METAFIELDS_SET_MUTATION = `#graphql
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { namespace key }
      userErrors { field message code }
    }
  }
`;

module.exports = { OWNERS, DEFINITIONS_QUERY, ownerValuesQuery, METAFIELDS_SET_MUTATION };
