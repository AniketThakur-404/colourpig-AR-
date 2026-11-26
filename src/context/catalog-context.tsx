"use client";

import React, { createContext, useContext } from "react";
import { Catalog, buildLocalCatalog, findShade } from "@/data/catalog";

const CatalogContext = createContext<Catalog | null>(null);

// Used only if a component renders outside the provider (e.g. in isolation)
const LOCAL_CATALOG = buildLocalCatalog();

/** Makes the server-fetched catalog (Shopify or local fallback) available to client components. */
export function CatalogProvider({ catalog, children }: { catalog: Catalog; children: React.ReactNode }) {
  return <CatalogContext.Provider value={catalog}>{children}</CatalogContext.Provider>;
}

export function useCatalog(): Catalog {
  return useContext(CatalogContext) ?? LOCAL_CATALOG;
}

interface ShadeCard {
  id: string;
  shadeId?: string;
  shadeCode?: string;
  price: number;
  image: string;
}

/**
 * Overlays the catalog's current Starter Kit price onto hand-curated product
 * cards. When connected to Shopify the card shows the product's first Shopify
 * image, and cards for shades Shopify no longer lists are dropped.
 *
 * `videoAt` picks the one card in the grid that autoplays its shade's video
 * (from Shopify when connected, else the card's local video); every other
 * card shows its photo. `allVideos` keeps every card's video instead (used by
 * grids that play the video on hover).
 */
export function useLiveCards<T extends ShadeCard & { video?: string }>(
  cards: T[],
  { videoAt, allVideos }: { videoAt?: number; allVideos?: boolean } = {}
): (T & { video?: string })[] {
  const { shades, source } = useCatalog();
  return cards.flatMap((card, index) => {
    const shade =
      findShade(shades, card.shadeId) ?? findShade(shades, card.id) ?? findShade(shades, card.shadeCode);
    if (!shade) return source === "shopify" ? [] : [card];
    const fromShopify = source === "shopify";
    const keepVideo = allVideos || index === videoAt;
    // A card without its own video falls back to its shade's video
    const video = keepVideo ? (fromShopify ? shade.video : card.video ?? shade.video) : undefined;
    return [{ ...card, price: shade.price, image: fromShopify ? shade.cardImage : card.image, video }];
  });
}
