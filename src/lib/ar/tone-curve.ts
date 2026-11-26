/**
 * Builds the lookup table the hair try-on shader recolours with.
 *
 * The table answers one question for every brightness a hair pixel can have:
 * "what should this pixel look like in the chosen shade?". It is built from
 * two things measured live: how bright the wearer's hair is (its darkest
 * shadows, its median, its highlights) and how well lit the scene is.
 *
 * The wearer's median hair brightness lands on the shade's median tone, and
 * their shadows and highlights are laid onto the shade's shadow and highlight
 * tones. So the head keeps its shape and shine, but in the new colour, and
 * grey strands are pulled down to the shade's own highlight level rather than
 * staying bright.
 */

import { HairShadeProfile, MID_STOP, Rgb, STOP_QUANTILES, luma } from "./shade-profiles";

/** Entries in the table (one per 8-bit brightness level) */
export const LUT_SIZE = 256;

/*
 * How steeply brightness may be stretched. Turning very dark hair light means
 * stretching a narrow band of near-black values across a wide range, which
 * also stretches camera noise; the cap keeps that under control.
 */
const MAX_SLOPE = 3.2;
const MIN_SLOPE = 0.25;

/*
 * How far the darkest hair may be lifted off black, as a share of the median
 * tone. With MAX_SLOPE this sets how much lighter than the wearer's hair a
 * shade can be drawn: about 4.5 times. Past that there is no detail left in
 * the picture to carry it: near-black hair pushed up to blonde comes out as
 * one flat tone, like paint. So a shade further away than that is drawn as
 * light as the hair can believably go, in that shade's colouring, with its
 * shadows still dark. (Root colour can't lift dark hair that far in real life
 * either, so this is also the truer preview.)
 */
const BLACK_LIFT = 0.3;

export interface ToneInputs {
  /** Brightness of the wearer's hair at each of STOP_QUANTILES (0–1) */
  hair: ArrayLike<number>;
  /** How well lit the scene is, relative to the photos the shade tones were measured from (1 = the same) */
  exposure: number;
  /** Colour of the light in the scene, normalised to brightness 1 */
  tint: Rgb;
}

export interface ToneResult {
  /** 0–0.7: how much to smooth pixel noise before recolouring (higher when lightening dark hair) */
  denoise: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Colour of the shade at a given brightness, following its shadow → highlight tones.
 * `shineFade` is how far the brightest shine fades toward the colour of the light.
 */
function shadeColourAt(stops: Rgb[], lumas: number[], y: number, shineFade: number, out: Rgb) {
  const last = stops.length - 1;
  let saturation = 1;
  let i = 0;
  let u = 0;

  if (y <= lumas[0]) {
    // Deeper than the shade's darkest measured tone: a touch richer as it falls away
    saturation = 1 + 0.15 * (1 - y / lumas[0]);
  } else if (y >= lumas[last]) {
    // Brighter than its brightest: shine picks up the colour of the light
    i = last;
    saturation = 1 - shineFade * clamp((y - lumas[last]) / (1 - lumas[last] + 1e-3), 0, 1);
  } else {
    while (i < last - 1 && y > lumas[i + 1]) i++;
    u = (y - lumas[i]) / (lumas[i + 1] - lumas[i] || 1e-6);
  }

  const a = stops[i];
  const b = stops[Math.min(i + 1, last)];
  const r = a[0] + (b[0] - a[0]) * u;
  const g = a[1] + (b[1] - a[1]) * u;
  const bl = a[2] + (b[2] - a[2]) * u;
  const k = y / Math.max(r * 0.299 + g * 0.587 + bl * 0.114, 1e-4);
  out[0] = y + (r * k - y) * saturation;
  out[1] = y + (g * k - y) * saturation;
  out[2] = y + (bl * k - y) * saturation;
}

/**
 * Fills `out` (LUT_SIZE × RGBA, 0–1 floats).
 *
 * Colour shades: RGB is the recoloured pixel and A its brightness.
 * Gloss (Clear): RGB is unused and A is a brightness change around 0.5
 * (0.5 = unchanged), because Clear keeps the wearer's own colour.
 */
export function buildToneLut(profile: HairShadeProfile, inputs: ToneInputs, out: Float32Array): ToneResult {
  const n = STOP_QUANTILES.length;

  // The wearer's hair brightness at each quantile, forced to rise steadily
  const src: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = clamp(inputs.hair[i], 0.004, 0.996);
    src.push(i > 0 ? Math.max(v, src[i - 1] + 0.006) : v);
  }

  if (profile.kind === "gloss") {
    const top = Math.min(1, src[n - 1] + 0.1);
    for (let x = 0; x < LUT_SIZE; x++) {
      const v = x / (LUT_SIZE - 1);
      const shine = smoothstep(src[MID_STOP], top, v);
      const depth = 1 - smoothstep(src[0], src[MID_STOP], v);
      // Brighter highlights, slightly deeper shadows: the look of a gloss coat
      const delta = v * (0.2 * Math.pow(shine, 1.5) * (1 - 0.6 * v) - 0.06 * depth);
      const o = x * 4;
      out[o] = out[o + 1] = out[o + 2] = 1;
      out[o + 3] = clamp(0.5 + delta * 2, 0, 1);
    }
    return { denoise: 0 };
  }

  const stops = profile.stops;
  const lumas = stops.map((s) => luma(s));

  // How brightly the shade is drawn: as the scene is lit, but no lighter than the
  // wearer's hair can carry (see BLACK_LIFT)
  // (Hair the camera has crushed to near-black is treated as a little brighter than it
  // reads, or the shade would barely show on it at all)
  const reach = (MAX_SLOPE * Math.max(src[MID_STOP], 0.035)) / (1 - BLACK_LIFT);
  const scale = Math.min(inputs.exposure, reach / lumas[MID_STOP]);
  const target = lumas.map((l) => l * scale);

  // Where each quantile of the wearer's hair should land, working out from the median
  const y: number[] = new Array(n).fill(0);
  y[MID_STOP] = target[MID_STOP];
  for (let i = MID_STOP + 1; i < n; i++) {
    const shadeRatio = target[i] / target[MID_STOP];
    const hairRatio = src[i] / src[MID_STOP];
    // Highlights stay close to the shade's own: this is what covers grey
    const want = target[MID_STOP] * shadeRatio * Math.sqrt(clamp(hairRatio / shadeRatio, 0.85, 1.3));
    const run = src[i] - src[i - 1];
    y[i] = y[i - 1] + clamp((want - y[i - 1]) / run, MIN_SLOPE, MAX_SLOPE) * run;
  }
  for (let i = MID_STOP - 1; i >= 0; i--) {
    const shadeRatio = target[i] / target[MID_STOP];
    const hairRatio = src[i] / src[MID_STOP];
    // Shadows follow the wearer's own depth more freely, so the head keeps its shape
    const want = target[MID_STOP] * shadeRatio * Math.pow(clamp(hairRatio / shadeRatio, 0.45, 1.25), 0.6);
    const run = src[i + 1] - src[i];
    y[i] = Math.max(0, y[i + 1] - clamp((y[i + 1] - want) / run, MIN_SLOPE, MAX_SLOPE) * run);
  }

  // How many times brighter the shade is than the wearer's hair, as 0 (no lighter) to 1 (8x or more).
  // Dark hair shows hard, bright glints. Stretched up to a light shade they would turn into
  // white blotches, so the lighter the shade is than the hair, the more the shine is held back.
  const lift = clamp((y[MID_STOP] / src[MID_STOP] - 2) / 6, 0, 1);

  const lowSlope = clamp(y[0] / src[0], MIN_SLOPE, MAX_SLOPE);
  const lastSlope = (y[n - 1] - y[n - 2]) / (src[n - 1] - src[n - 2]);
  const highSlope = clamp(lastSlope * 0.6, 0.15, 1.5) * (1 - 0.6 * lift);
  // Shine rolls off smoothly instead of clipping
  const peak = y[n - 1];
  const ceiling = Math.min(0.985, peak + (0.5 - 0.3 * lift) * (1 - peak) + 0.05 * (1 - lift));
  const shineFade = 0.75 - 0.35 * lift;

  const curve = new Float32Array(LUT_SIZE);
  for (let x = 0; x < LUT_SIZE; x++) {
    const v = x / (LUT_SIZE - 1);
    let f: number;
    if (v <= src[0]) {
      f = Math.max(0, y[0] - lowSlope * (src[0] - v));
    } else if (v >= src[n - 1]) {
      const over = highSlope * (v - src[n - 1]);
      const room = Math.max(ceiling - peak, 1e-3);
      f = peak + room * (1 - Math.exp(-over / room));
    } else {
      let i = 0;
      while (i < n - 2 && v > src[i + 1]) i++;
      f = y[i] + ((y[i + 1] - y[i]) * (v - src[i])) / (src[i + 1] - src[i]);
    }
    curve[x] = f;
  }

  // Round off the corners between segments so no tone step shows in the hair
  const smooth = new Float32Array(LUT_SIZE);
  for (let pass = 0; pass < 2; pass++) {
    for (let x = 0; x < LUT_SIZE; x++) {
      let sum = 0;
      for (let k = -4; k <= 4; k++) sum += curve[clamp(x + k, 0, LUT_SIZE - 1)];
      smooth[x] = sum / 9;
    }
    curve.set(smooth);
  }

  const tint = inputs.tint;
  const colour: Rgb = [0, 0, 0];
  for (let x = 0; x < LUT_SIZE; x++) {
    const lit = curve[x];
    // The shade's colour at this point of its shadow → highlight range
    shadeColourAt(stops, lumas, lit / scale, shineFade, colour);

    // Tinted by the scene's light, keeping its brightness on the curve
    let r = colour[0] * tint[0];
    let g = colour[1] * tint[1];
    let b = colour[2] * tint[2];
    const k = lit / Math.max(r * 0.299 + g * 0.587 + b * 0.114, 1e-4);
    r *= k;
    g *= k;
    b *= k;

    // Anything brighter than the screen can show rolls toward white, not a flat clip
    const max = Math.max(r, g, b);
    if (max > 1) {
      const keep = clamp((1 - lit) / Math.max(max - lit, 1e-4), 0, 1);
      r = lit + (r - lit) * keep;
      g = lit + (g - lit) * keep;
      b = lit + (b - lit) * keep;
    }

    const o = x * 4;
    out[o] = clamp(r, 0, 1);
    out[o + 1] = clamp(g, 0, 1);
    out[o + 2] = clamp(b, 0, 1);
    out[o + 3] = clamp(lit, 0, 1);
  }

  const midSlope = (y[MID_STOP + 1] - y[MID_STOP - 1]) / (src[MID_STOP + 1] - src[MID_STOP - 1]);
  return { denoise: clamp((midSlope - 1.4) / 2.2, 0, 0.7) };
}
