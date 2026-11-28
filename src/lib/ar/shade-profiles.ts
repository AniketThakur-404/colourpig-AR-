/**
 * How the hair try-on paints each shade.
 *
 * A head of hair is never one flat colour: it runs from deep, saturated
 * shadows between the strands to pale highlights where the light catches it.
 * Each shade is therefore described by seven tones, from the darkest 3% of
 * the hair up to the brightest 3%, measured from the brand's own on-model
 * photo of that shade (public/images/results/model_shade_*.jpg). The try-on
 * lays those tones over the wearer's own light and shadow.
 *
 * A flat swatch is no use for this: it is lit evenly from the front, so it is
 * far brighter than the same shade worn, and painting hair with swatch tones
 * gives a flat, wig-like result.
 */

import { swatchThumbnail, type ShadeProduct } from "@/data/shades";
import { oklchOf, type OkLch } from "./oklab";

export type Rgb = [number, number, number];

export interface HairShadeProfile {
  /** "colour" replaces the hair's tone; "gloss" keeps it and only adds shine (No.0/0 Clear) */
  kind: "colour" | "gloss";
  /** Seven tones as worn, from deepest shadow to brightest highlight (sRGB, 0–1) */
  stops: Rgb[];
  /**
   * true: dye on real hair, laid over by colour transfer (see `natural` in hair-shaders.ts)
   * toward the swatch's colour. Unset: the shade's tones replace the hair's outright
   * (No.0/0 Clear's silver).
   */
  natural?: boolean;
  /** The swatch's mean colour in OKLab: lightness, chroma and hue (radians) */
  swatch?: OkLch;
  /**
   * Light shades only (No.7 and lighter): 1 = the dye blend lightens each strand in
   * proportion to its own lightness instead of by one fixed amount (see `natural` in
   * hair-shaders.ts). Unset for darker shades, whose blend is unchanged.
   */
  lighten?: number;
}

/** Swatch lightness (OKLab L) from which a shade counts as light: No.7 is 0.68, No.6 0.47 */
const LIGHT_SWATCH_L = 0.6;

/** The `lighten` setting for a dye shade with this swatch colour */
const lightenFor = (swatch: OkLch) => (swatch.L >= LIGHT_SWATCH_L ? 0.6 : undefined);

/**
 * Each shade's swatch photo (public/images/products/swatches/clean) measured in OKLab:
 * the mean lightness, mean chroma and mean hue over the middle of the swatch. This is the
 * colour the dye blend moves the hair toward.
 */
const deg = (d: number) => (d * Math.PI) / 180;
const SWATCH_OKLAB: Record<string, OkLch> = {
  "shade-1": { L: 0.264, C: 0.0025, h: deg(-43.9) },
  "shade-3": { L: 0.228, C: 0.0109, h: deg(44.6) },
  "shade-4": { L: 0.361, C: 0.0256, h: deg(60.8) },
  "shade-5": { L: 0.423, C: 0.0324, h: deg(53.8) },
  "shade-6": { L: 0.474, C: 0.05, h: deg(63.5) },
  "shade-7": { L: 0.682, C: 0.0753, h: deg(66.8) },
  "shade-8": { L: 0.746, C: 0.0732, h: deg(63.8) },
  "shade-9": { L: 0.836, C: 0.0501, h: deg(67.5) },
};

/** Share of the hair that is darker than each tone */
export const STOP_QUANTILES = [0.03, 0.15, 0.3, 0.5, 0.7, 0.85, 0.97] as const;

/** Index of the middle tone (the median) in STOP_QUANTILES */
export const MID_STOP = 3;

export const luma = (c: ArrayLike<number>) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Tones of each shade as worn, shadow → highlight. Measured by running the
 * try-on's own hair segmentation over the on-model photo of each shade and
 * averaging the hair pixels around each of STOP_QUANTILES.
 */
const WORN_TONES: Record<string, string[]> = {
  "shade-1": ["#020404", "#060809", "#0A0C0D", "#111312", "#1C1C1B", "#292927", "#42403D"],
  "shade-3": ["#0A0301", "#110905", "#160F09", "#1D1610", "#271F19", "#342C25", "#4D443C"],
  "shade-4": ["#0A0603", "#160E09", "#1F150D", "#281D14", "#34281E", "#42352A", "#5E5044"],
  "shade-5": ["#0E0703", "#201209", "#2D1B0E", "#3A2615", "#493220", "#59412E", "#785F4C"],
  "shade-6": ["#150A03", "#2B1909", "#392410", "#483019", "#593E26", "#6A4E35", "#896C52"],
  "shade-7": ["#1E1106", "#412811", "#57391D", "#6B4A2B", "#7F5C3C", "#93704E", "#B6936F"],
  "shade-8": ["#301F12", "#573A23", "#6C4B30", "#7E5C3F", "#926F50", "#A48263", "#C4A384"],
  "shade-9": ["#4D3728", "#795D49", "#8A6E59", "#9C806B", "#AC927D", "#BCA491", "#D5C2B2"],
};

/**
 * Brightness of the brightest surfaces in the photos WORN_TONES was measured
 * from. The engine compares the wearer's scene against this to light the shade
 * the way their own scene is lit.
 */
export const WORN_TONES_SCENE_WHITE = 0.72;

/**
 * How bright the darker hair (30th percentile) of each depth level is in those photos,
 * from level 2 (No.1 Black) to level 9 (No.9 Very Light Blonde).
 */
const LEVEL_TONES: [level: number, tone: number][] = [
  [2, 0.046],
  [3, 0.063],
  [4, 0.091],
  [5, 0.122],
  [6, 0.157],
  [7, 0.247],
  [8, 0.321],
  [9, 0.454],
];

/**
 * The depth level (1 = black … 10 = lightest blonde) that hair of the given
 * brightness looks like. `tone` is the brightness of the wearer's darker,
 * pigmented hair, already divided by how brightly their scene is lit. It is an
 * estimate from a camera picture: good to about a level either way.
 */
export function levelFromHairTone(tone: number): number {
  const first = LEVEL_TONES[0];
  const last = LEVEL_TONES[LEVEL_TONES.length - 1];
  if (tone <= first[1]) return Math.max(1, first[0] - (1 - tone / first[1]));
  if (tone >= last[1]) return Math.min(10, last[0] + (tone / last[1] - 1) * 2);
  let i = 0;
  while (tone > LEVEL_TONES[i + 1][1]) i++;
  const [levelA, toneA] = LEVEL_TONES[i];
  const [levelB, toneB] = LEVEL_TONES[i + 1];
  return levelA + ((tone - toneA) / (toneB - toneA)) * (levelB - levelA);
}

const GLOSS_PROFILE: HairShadeProfile = { kind: "gloss", stops: [] };

/*
 * A shade with no on-model photo (one added later in Shopify) gets its worn
 * tones worked out instead, from what the measured shades have in common:
 *  - darker shades spread wider from shadow to highlight than lighter ones;
 *  - a swatch photo is lit flat, so the shade worn is about two thirds as
 *    bright as its swatch, and a little more saturated;
 *  - failing a swatch photo, the shade worn is about half as bright as its
 *    hex, with shadows far more saturated than highlights.
 * Tones read from the swatch photo land close to measured ones (checked on the
 * eight measured shades: hue within a few degrees). The hex is a last resort:
 * the swatch colours set in Shopify are often not hair colours at all.
 */
const DARK_SPREAD = [0.21, 0.52, 0.73, 1, 1.34, 1.77, 2.62]; // No.4, relative to its median
const LIGHT_SPREAD = [0.45, 0.74, 0.87, 1, 1.13, 1.27, 1.48]; // No.9
const DARK_MEDIAN = 0.124; // worn median of No.4
const LIGHT_MEDIAN = 0.524; // worn median of No.9

const HEX_SATURATION = [2, 1.8, 1.65, 1.5, 1.3, 1.1, 0.9];
const SWATCH_SATURATION = 1.2;
const SWATCH_TO_WORN = 0.64;

/**
 * Seven worn tones around `median`, each taking its hue from `colourAt(i)` and
 * having that colour's saturation multiplied by `saturationAt(i)`.
 */
function spreadTones(median: number, colourAt: (i: number) => Rgb, saturationAt: (i: number) => number): Rgb[] {
  const lightness = clamp01((median - DARK_MEDIAN) / (LIGHT_MEDIAN - DARK_MEDIAN));
  return STOP_QUANTILES.map((_, i) => {
    const colour = colourAt(i);
    const y = Math.min(0.97, median * (DARK_SPREAD[i] + (LIGHT_SPREAD[i] - DARK_SPREAD[i]) * lightness));
    const k = y / Math.max(luma(colour), 1e-4);
    // Saturate around the tone's own brightness, stopping before any channel would go negative
    const lowest = Math.min(colour[0], colour[1], colour[2]) * k;
    const saturation = Math.min(saturationAt(i), lowest < y ? y / (y - lowest) : saturationAt(i));
    return colour.map((c) => clamp01(y + (c * k - y) * saturation)) as Rgb;
  });
}

function tonesFromHex(hex: string): Rgb[] {
  const base = hexToRgb(hex) ?? [0.31, 0.25, 0.21];
  const baseLuma = Math.max(luma(base), 0.02);
  // 0 = a hex as dark as No.4 Medium Brown's, 1 = as light as No.9 Very Light Blonde's
  const lightness = clamp01((baseLuma - 0.27) / (0.8 - 0.27));
  return spreadTones(
    baseLuma * (0.47 + 0.18 * lightness),
    () => base,
    (i) => HEX_SATURATION[i]
  );
}

/** Reads a swatch photo's own tones, shadow → highlight; null if it can't be read. */
async function readSwatchTones(url: string): Promise<Rgb[] | null> {
  try {
    const image = new Image();
    // Needed to read pixels of an image from another origin (Shopify's CDN allows it)
    image.crossOrigin = "anonymous";
    image.src = url;
    await image.decode();

    const size = 96;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, size, size);

    // The middle of the picture only: round swatches have a rim and empty corners
    const inset = Math.round(size * 0.2);
    const span = size - inset * 2;
    const { data } = ctx.getImageData(inset, inset, span, span);
    const pixels: Rgb[] = [];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 250) pixels.push([data[i] / 255, data[i + 1] / 255, data[i + 2] / 255]);
    }
    if (pixels.length < span * span * 0.5) return null;
    pixels.sort((a, b) => luma(a) - luma(b));

    return STOP_QUANTILES.map((q) => {
      const from = Math.floor(pixels.length * Math.max(0, q - 0.03));
      const to = Math.max(from + 1, Math.ceil(pixels.length * Math.min(1, q + 0.03)));
      const sum: Rgb = [0, 0, 0];
      for (let i = from; i < to; i++) for (let c = 0; c < 3; c++) sum[c] += pixels[i][c];
      return sum.map((v) => v / (to - from)) as Rgb;
    });
  } catch {
    // Couldn't load, or the server doesn't allow its pixels to be read
    return null;
  }
}

type ProfiledShade = Pick<ShadeProduct, "id" | "name" | "hex" | "colorFamily" | "swatchImage" | "swatchThumb">;

const profileCache = new Map<string, HairShadeProfile>();
const cacheKey = (shade: ProfiledShade) => `${shade.id}|${shade.hex}`;

/**
 * The try-on profile for a shade, available at once: its measured worn tones,
 * or else tones worked out from its hex (see loadSwatchProfile for a better
 * estimate that takes a moment).
 */
export function getHairShadeProfile(shade: ProfiledShade): HairShadeProfile {
  if (shade.id === "shade-0-0" || shade.colorFamily === "clear" || /\bclear\b/i.test(shade.name)) {
    return GLOSS_PROFILE;
  }

  const cached = profileCache.get(cacheKey(shade));
  if (cached) return cached;

  const measured = WORN_TONES[shade.id];
  const stops = measured ? measured.map((hex) => hexToRgb(hex)!) : tonesFromHex(shade.hex);

  // Clear's silver replaces the hair's tones; every dye shade keeps the wearer's own
  const natural = shade.id !== "shade-0-0";
  const swatch = SWATCH_OKLAB[shade.id] ?? oklchOf(hexToRgb(shade.hex) ?? stops[MID_STOP]);
  const profile: HairShadeProfile = natural
    ? { kind: "colour", stops, natural, swatch, lighten: lightenFor(swatch) }
    : { kind: "colour", stops };
  profileCache.set(cacheKey(shade), profile);
  return profile;
}

const swatchProfiles = new Map<string, Promise<HairShadeProfile | null>>();

/**
 * For a shade without measured tones: a profile read from its swatch photo,
 * which is truer than the one worked out from its hex. Resolves null when the
 * shade doesn't need one (it is measured, or Clear) or the photo can't be read.
 * Once resolved, getHairShadeProfile returns the same profile.
 */
export function loadSwatchProfile(shade: ProfiledShade): Promise<HairShadeProfile | null> {
  if (WORN_TONES[shade.id] || getHairShadeProfile(shade).kind === "gloss") return Promise.resolve(null);

  const key = cacheKey(shade);
  let pending = swatchProfiles.get(key);
  if (!pending) {
    pending = readSwatchTones(swatchThumbnail(shade)).then((tones) => {
      if (!tones) return null;
      const swatch = oklchOf(tones[MID_STOP]);
      const stops = spreadTones(
        luma(tones[MID_STOP]) * SWATCH_TO_WORN,
        (i) => tones[i],
        () => SWATCH_SATURATION
      );
      const profile: HairShadeProfile = {
        kind: "colour",
        natural: true,
        swatch,
        lighten: lightenFor(swatch),
        stops,
      };
      profileCache.set(key, profile);
      return profile;
    });
    swatchProfiles.set(key, pending);
  }
  return pending;
}
