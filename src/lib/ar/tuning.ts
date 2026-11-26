/**
 * Settings for the dye blend (see `natural` in hair-shaders.ts). The defaults are the
 * shipped look. The try-on shows sliders for these when its page is opened with ?tune,
 * and the test grid at /try-on-test renders every shade with them.
 */

export interface TryOnTuning {
  /** How far the hair's mean lightness moves toward the swatch's (0 = not at all, 1 = all the way) */
  lift: number;
  /** How much of the recoloured hair replaces the original */
  strength: number;
  /** Least chroma, as a share of the swatch's, that the darkest strands get */
  chromaFloor: number;
  /** Hair probability counted as half hair */
  maskThreshold: number;
  /** Guided filter radius (how far the mask is fitted to the picture's edges), in camera pixels */
  guidedRadius: number;
  /** Width of the soft outer edge of the hair, in camera pixels */
  feather: number;
}

export const DEFAULT_TUNING: TryOnTuning = {
  lift: 0.2,
  strength: 0.75,
  chromaFloor: 0.35,
  maskThreshold: 0.3,
  guidedRadius: 10,
  feather: 8,
};

export const TUNING_SLIDERS: { key: keyof TryOnTuning; label: string; min: number; max: number; step: number }[] = [
  { key: "lift", label: "Lift (mean toward swatch)", min: 0, max: 0.6, step: 0.01 },
  { key: "strength", label: "Strength", min: 0, max: 1, step: 0.01 },
  { key: "chromaFloor", label: "Chroma floor", min: 0, max: 1, step: 0.01 },
  { key: "maskThreshold", label: "Mask threshold", min: 0.15, max: 0.6, step: 0.01 },
  { key: "guidedRadius", label: "Guided filter radius (px)", min: 4, max: 24, step: 1 },
  { key: "feather", label: "Matte feather (px)", min: 0, max: 16, step: 0.5 },
];
