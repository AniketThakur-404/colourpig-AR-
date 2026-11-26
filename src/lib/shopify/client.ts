import "server-only";

/**
 * Shopify Storefront API client. Server-side only: the access tokens never
 * reach the browser. The private token is preferred; the public token is used
 * when no private token is set.
 */

const domain = (process.env.SHOPIFY_STORE_DOMAIN || process.env.NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN || "")
  .trim()
  .replace(/^https?:\/\//i, "")
  .replace(/\/+$/, "");

const privateToken =
  process.env.SHOPIFY_STOREFRONT_PRIVATE_ACCESS_TOKEN || process.env.SHOPIFY_PRIVATE_ACCESS_TOKEN || "";

const publicToken =
  process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN || process.env.NEXT_PUBLIC_SHOPIFY_STOREFRONT_ACCESS_TOKEN || "";

const apiVersion = process.env.SHOPIFY_API_VERSION || "2026-10";

export const isShopifyConfigured = Boolean(domain && (privateToken || publicToken));

const endpoint = isShopifyConfigured ? `https://${domain}/api/${apiVersion}/graphql.json` : null;

export class ShopifyError extends Error {}

// Set once Shopify has refused the private token, so later requests go straight to the public one
let privateTokenRejected = false;

interface ShopifyFetchOptions {
  variables?: Record<string, unknown>;
  /** Seconds to cache the response for. Omit for uncached requests (mutations, carts). */
  revalidate?: number;
  tags?: string[];
}

export async function shopifyFetch<T>(
  query: string,
  { variables = {}, revalidate, tags }: ShopifyFetchOptions = {}
): Promise<T> {
  if (!endpoint) {
    throw new ShopifyError("Shopify is not configured: set the store domain and a Storefront access token.");
  }

  const send = (usePrivateToken: boolean) =>
    fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(usePrivateToken
          ? { "Shopify-Storefront-Private-Token": privateToken }
          : { "X-Shopify-Storefront-Access-Token": publicToken }),
      },
      body: JSON.stringify({ query, variables }),
      ...(revalidate !== undefined ? { next: { revalidate, tags } } : { cache: "no-store" as const }),
    });

  const sentPrivateToken = Boolean(privateToken) && !privateTokenRejected;
  let res = await send(sentPrivateToken);

  // A private token that Shopify refuses (revoked, or not a Storefront token) would otherwise
  // leave the whole site on local fallback data. The public token reads the same catalog.
  // Several requests can be in flight when the first refusal comes back, so each one that
  // went out with the private token retries, whether or not another has already flagged it.
  if ((res.status === 401 || res.status === 403) && sentPrivateToken && publicToken) {
    if (!privateTokenRejected) {
      privateTokenRejected = true;
      console.warn(
        `[shopify] The private Storefront token was refused (${res.status}); using the public token instead. ` +
          "Check SHOPIFY_STOREFRONT_PRIVATE_ACCESS_TOKEN."
      );
    }
    res = await send(false);
  }

  const text = await res.text();
  let json: { data?: T; errors?: { message: string }[] };
  try {
    json = JSON.parse(text);
  } catch {
    throw new ShopifyError(`Shopify returned a non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    throw new ShopifyError(`Shopify request failed (${res.status}): ${text.slice(0, 200)}`);
  }
  if (json.errors?.length) {
    throw new ShopifyError(json.errors.map((e) => e.message).join("; "));
  }
  if (!json.data) {
    throw new ShopifyError("Shopify returned no data.");
  }
  return json.data;
}
