'use strict';

const DEFAULT_API_VERSION = '2025-10';
const MAX_RETRIES = 5;

class ShopifyGraphQLError extends Error {
  constructor(message, { status, errors, throttled } = {}) {
    super(message);
    this.name = 'ShopifyGraphQLError';
    this.status = status;
    this.errors = errors;
    this.throttled = throttled;
  }
}

/**
 * Minimal Admin GraphQL client: no dependencies, cost-aware retry on
 * THROTTLED errors and HTTP 429s.
 */
class ShopifyGraphQLClient {
  constructor({ shop, accessToken, apiVersion = DEFAULT_API_VERSION, fetchImpl = fetch } = {}) {
    if (!shop) throw new Error('shop is required (e.g. my-store.myshopify.com)');
    if (!accessToken) throw new Error('accessToken is required');
    this.shop = shop;
    this.accessToken = accessToken;
    this.apiVersion = apiVersion;
    this.fetchImpl = fetchImpl;
    this.endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
  }

  async request(query, variables = {}, { retries = MAX_RETRIES } = {}) {
    let attempt = 0;
    let lastError;

    while (attempt <= retries) {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': this.accessToken,
        },
        body: JSON.stringify({ query, variables }),
      });

      if (response.status === 429) {
        lastError = new ShopifyGraphQLError('Rate limited (HTTP 429)', { status: 429, throttled: true });
        await backoff(response, attempt);
        attempt += 1;
        continue;
      }

      const body = await response.json();

      if (!response.ok) {
        throw new ShopifyGraphQLError(
          `Admin API request failed with HTTP ${response.status}`,
          { status: response.status, errors: body.errors }
        );
      }

      const throttledError = (body.errors || []).find((e) => e.extensions?.code === 'THROTTLED');
      if (throttledError) {
        lastError = new ShopifyGraphQLError('Rate limited (query cost throttled)', {
          errors: body.errors,
          throttled: true,
        });
        const availableAt = estimateThrottleWaitMs(body.extensions);
        await sleep(availableAt);
        attempt += 1;
        continue;
      }

      if (body.errors && body.errors.length > 0) {
        throw new ShopifyGraphQLError(
          `Admin API returned errors: ${body.errors.map((e) => e.message).join('; ')}`,
          { errors: body.errors }
        );
      }

      return { data: body.data, extensions: body.extensions };
    }

    throw lastError || new ShopifyGraphQLError('Admin API request failed after retries');
  }
}

function estimateThrottleWaitMs(extensions) {
  const status = extensions?.cost?.throttleStatus;
  if (!status || !status.restoreRate) return 1000;
  const deficit = Math.max(0, (status.maximumAvailable || 1000) * 0.1);
  return Math.min(5000, Math.ceil((deficit / status.restoreRate) * 1000));
}

async function backoff(response, attempt) {
  const retryAfter = Number(response.headers?.get?.('Retry-After'));
  const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
    ? retryAfter * 1000
    : Math.min(8000, 250 * 2 ** attempt);
  await sleep(waitMs);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { ShopifyGraphQLClient, ShopifyGraphQLError, DEFAULT_API_VERSION };
