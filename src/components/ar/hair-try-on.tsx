"use client";

import dynamic from "next/dynamic";
import { LoaderCircle } from "lucide-react";
import type { HairTryOnModalProps } from "./hair-try-on-modal";

// The try-on brings the camera, WebGL and segmentation code with it, so it is
// fetched only when a shopper opens it, never with the product page itself.
const HairTryOnModal = dynamic(() => import("./hair-try-on-modal").then((mod) => mod.HairTryOnModal), {
  ssr: false,
  loading: () => (
    <div role="status" aria-label="Opening try-on" className="fixed inset-0 z-[95] bg-obsidian/85 backdrop-blur-sm flex items-center justify-center">
      <LoaderCircle className="w-8 h-8 text-white animate-spin" />
    </div>
  ),
});

// Shades left out of the try-on. All shades are shown for now while they're being tested;
// uncomment an id to hide that shade from the try-on again.
const HIDDEN_TRY_ON_SHADES: string[] = [
  // "shade-7", // No.7 Medium Blonde
  // "shade-8", // No.8 Light Blonde
  // "shade-9", // No.9 Very Light Blonde
];

/** Whether a shade can be shown in the try-on. */
export function canTryOnShade(shadeId: string) {
  return !HIDDEN_TRY_ON_SHADES.includes(shadeId);
}

/** Starts fetching the try-on code early, e.g. when the pointer reaches its button. */
export function preloadHairTryOn() {
  void import("./hair-try-on-modal");
}

interface HairTryOnProps extends Omit<HairTryOnModalProps, "initialShadeId"> {
  /** Shade to open the try-on with; null keeps it closed */
  shadeId: string | null;
}

/** Virtual hair colour try-on. Render it once per page and open it by passing a shade id. */
export function HairTryOn({ shadeId, ...modalProps }: HairTryOnProps) {
  if (!shadeId) return null;
  return <HairTryOnModal initialShadeId={shadeId} {...modalProps} />;
}
