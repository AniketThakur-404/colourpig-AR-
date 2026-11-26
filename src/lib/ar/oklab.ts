/**
 * OKLab, the colour space the dye blend works in (see `natural` in hair-shaders.ts).
 * L runs 0–1; a and b are the green–red and blue–yellow axes. Chroma is the length of
 * (a, b) and hue its angle (about 60° is golden brown, lower is redder).
 */

import type { Rgb } from "./shade-profiles";

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

export type OkLab = [L: number, a: number, b: number];

export function rgbToOklab(rgb: ArrayLike<number>): OkLab {
  const r = toLinear(rgb[0]);
  const g = toLinear(rgb[1]);
  const b = toLinear(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** A shade's colour in OKLab polar form: mean lightness, mean chroma, hue in radians. */
export interface OkLch {
  L: number;
  C: number;
  h: number;
}

export function oklchOf(colour: Rgb): OkLch {
  const [L, a, b] = rgbToOklab(colour);
  return { L, C: Math.hypot(a, b), h: Math.atan2(b, a) };
}

/** OKLab lightness of an sRGB colour given as 0–255 bytes, via a lookup of the linear values. */
const LINEAR = Float32Array.from({ length: 256 }, (_, v) => toLinear(v / 255));
export function oklabLightness(r: number, g: number, b: number): number {
  const lr = LINEAR[r];
  const lg = LINEAR[g];
  const lb = LINEAR[b];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}
