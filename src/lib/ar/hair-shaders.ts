/**
 * GLSL for the hair try-on (WebGL2).
 *
 * The segmentation model only says roughly where the hair is: a soft 256px
 * mask. These passes turn that into a mask that follows individual strands,
 * holds still from frame to frame, and stays off anything in front of the hair.
 *
 * Precise pipeline (needs half-float render targets; nearly every device has them):
 *  1. MOMENTS + COEFFICIENTS work out, for each small region, how the picture's
 *     colours relate to the mask there ("in this region dark means hair, pale
 *     means background"). Applying that rule to the full-resolution picture
 *     gives a mask at the picture's own sharpness, strand by strand. This is a
 *     guided filter.
 *  2. FIELDS records the colour of the hair and of its surroundings region by region.
 *  3. STEADY decides how much of each pixel to colour, then blends the answer
 *     (and the pixel's brightness) with the previous frame's wherever the
 *     picture has not moved. That removes shimmer and camera grain without
 *     trailing behind real movement.
 *  4. COMPOSITE recolours through the tone lookup table.
 *
 * Fallback pipeline: MATTE (a simpler edge-following blur of the mask), FIELDS,
 * then COMPOSITE doing the coverage decision itself, with no steadying.
 *
 * All image coordinates run top-to-bottom (v = 0 is the top row).
 */

export const VERTEX = /* glsl */ `#version 300 es
in vec2 aPosition;
uniform float uFlipY;
out vec2 vUv;
void main() {
  vUv = vec2(aPosition.x * 0.5 + 0.5, uFlipY > 0.5 ? 0.5 - aPosition.y * 0.5 : 0.5 + aPosition.y * 0.5);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

/** The model's mask, read in picture coordinates (it covers only the head crop). */
const MASK_AT = /* glsl */ `
uniform sampler2D uMask;
uniform vec4 uRoi; // xy: crop origin in frame uv, zw: 1 / crop size in frame uv

float maskAt(vec2 uv) {
  vec2 m = (uv - uRoi.xy) * uRoi.zw;
  vec2 inside = step(vec2(0.0), m) * step(m, vec2(1.0));
  return texture(uMask, m).r * inside.x * inside.y;
}`;

/*
 * Fallback: each output pixel looks at the mask around it, but trusts a
 * neighbour only if that neighbour is a similar colour in the picture. Mask
 * values stop spreading at a real colour edge, which pulls the soft edge onto
 * the hairline.
 */
export const MATTE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D uFrame;
uniform vec2 uMaskTexel; // one mask pixel, in frame uv
uniform float uGuideLod; // how much to smooth the picture before comparing colours
uniform float uColourFalloff;
${MASK_AT}

in vec2 vUv;
out vec4 outColour;

const vec2 RING[12] = vec2[12](
  vec2(1.0, 0.0), vec2(0.5, 0.866), vec2(-0.5, 0.866),
  vec2(-1.0, 0.0), vec2(-0.5, -0.866), vec2(0.5, -0.866),
  vec2(1.732, 1.0), vec2(0.0, 2.0), vec2(-1.732, 1.0),
  vec2(-1.732, -1.0), vec2(0.0, -2.0), vec2(1.732, -1.0)
);

void main() {
  vec3 here = textureLod(uFrame, vUv, uGuideLod).rgb;
  float sum = maskAt(vUv);
  float weight = 1.0;

  for (int i = 0; i < 12; i++) {
    vec2 uv = vUv + RING[i] * uMaskTexel;
    vec3 diff = textureLod(uFrame, uv, uGuideLod).rgb - here;
    float w = (i < 6 ? 0.8 : 0.45) * exp(-dot(diff, diff) * uColourFalloff);
    sum += w * maskAt(uv);
    weight += w;
  }

  outColour = vec4(sum / weight, 0.0, 0.0, 1.0);
}`;

/*
 * Guided filter, step 1: per small pixel, the picture's colour I (centred on
 * mid-grey for precision), the mask p, and their products. Blurring these
 * (through mipmaps) gives the averages the next step needs.
 */
export const MOMENTS_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D uFrame;
${MASK_AT}

in vec2 vUv;
layout(location = 0) out vec4 outA; // I, p
layout(location = 1) out vec4 outB; // I * p, Ir * Ir
layout(location = 2) out vec4 outC; // Ir * Ig, Ir * Ib, Ig * Ig, Ig * Ib
layout(location = 3) out vec4 outD; // Ib * Ib

void main() {
  vec3 i = texture(uFrame, vUv).rgb - 0.5;
  float p = maskAt(vUv);
  outA = vec4(i, p);
  outB = vec4(i * p, i.r * i.r);
  outC = vec4(i.r * i.g, i.r * i.b, i.g * i.g, i.g * i.b);
  outD = vec4(i.b * i.b, 0.0, 0.0, 1.0);
}`;

/*
 * Guided filter, step 2: within each window, the straight-line rule
 * mask = a . colour + b that best fits the model's mask. Where hair and
 * background differ in colour the rule is steep and the mask will follow
 * every strand; where they don't (uEpsilon decides how much difference
 * counts) it flattens out to the plain blurred mask.
 */
export const COEFFICIENTS_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D uMomentA;
uniform sampler2D uMomentB;
uniform sampler2D uMomentC;
uniform sampler2D uMomentD;
uniform float uWindowLod;
uniform float uEpsilon;

in vec2 vUv;
out vec4 outFit;

void main() {
  vec4 a = textureLod(uMomentA, vUv, uWindowLod);
  vec4 b = textureLod(uMomentB, vUv, uWindowLod);
  vec4 c = textureLod(uMomentC, vUv, uWindowLod);
  float bb = textureLod(uMomentD, vUv, uWindowLod).r;

  vec3 mean = a.rgb;
  float meanMask = a.a;
  vec3 together = b.rgb - mean * meanMask; // how colour and mask vary together
  mat3 spread = mat3(
    b.a - mean.r * mean.r + uEpsilon, c.r - mean.r * mean.g, c.g - mean.r * mean.b,
    c.r - mean.r * mean.g, c.b - mean.g * mean.g + uEpsilon, c.a - mean.g * mean.b,
    c.g - mean.r * mean.b, c.a - mean.g * mean.b, bb - mean.b * mean.b + uEpsilon
  );
  vec3 slope = inverse(spread) * together;
  outFit = vec4(slope, meanMask - dot(slope, mean));
}`;

/*
 * Writes two small pictures: one holding only what is certainly hair, one only
 * what is certainly not. Blurring each (through its mipmaps) and dividing the
 * colour by the coverage gives, for any spot, the average colour of the hair
 * near it and of the background near it.
 */
export const FIELDS_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D uFrame;
uniform sampler2D uMatte;
uniform vec4 uPick; // which channel of uMatte holds the mask

in vec2 vUv;
layout(location = 0) out vec4 outHair;
layout(location = 1) out vec4 outBack;

void main() {
  vec3 colour = texture(uFrame, vUv).rgb;
  float matte = dot(texture(uMatte, vUv), uPick);
  float hair = smoothstep(0.8, 0.95, matte);
  float back = 1.0 - smoothstep(0.03, 0.12, matte);
  outHair = vec4(colour * hair, hair);
  outBack = vec4(colour * back, back);
}`;

/**
 * How to treat a pixel, given the mask there and the pixel itself. Shared by both pipelines.
 * Returns x: how much of the pixel to recolour outright, y: for the rest of it, what share
 * is hair mixed into something else (see the end of the function).
 */
const HAIR_COVER = /* glsl */ `
uniform vec2 uHairRange; // the wearer's darkest and brightest hair tones, as photographed
uniform sampler2D uHairField;
uniform sampler2D uBackField;
uniform vec4 uSkin; // rgb: the wearer's skin tone. a: how far it can be trusted to tell skin from their hair
uniform float uThreshold; // mask confidence counted as half hair (0.4 before tuning existed)

const vec3 LUMA = vec3(0.299, 0.587, 0.114);

// Colour (times coverage) and coverage around a spot. The nearest surroundings count
// most; wider ones fill in where there is nothing certain close by.
vec4 nearby(sampler2D field, vec2 uv) {
  return textureLod(field, uv, 1.5) + 0.25 * textureLod(field, uv, 3.0) + 0.0625 * textureLod(field, uv, 4.5);
}

vec2 hairCover(float matte, float nearHair, vec3 source, vec2 uv) {
  float y = dot(source, LUMA);

  // Coverage comes first: hair is covered generously right to its edge, so no rim of
  // the old colour (or of grey) is left. The one exception is a pixel the mask is
  // unsure about that is also brighter than any of the wearer's hair, or far darker:
  // that is background showing between loose strands, and it is covered only as far
  // as the mask is confident, so the colour doesn't hang in the air around frizzy hair.
  float tooBright = smoothstep(uHairRange.y + 0.06, uHairRange.y + 0.24, y);
  float tooDark = (1.0 - smoothstep(uHairRange.x * 0.3, uHairRange.x * 0.7, y)) * smoothstep(0.1, 0.2, uHairRange.x);
  // The model's soft hair probability is the alpha; uThreshold is where it counts as half hair
  float cover = mix(smoothstep(uThreshold - 0.17, uThreshold + 0.25, matte), smoothstep(0.45, 0.9, matte), max(tooBright, tooDark));
  if (nearHair < 0.03) return vec2(cover, 0.0);

  vec4 hairField = nearby(uHairField, uv);
  vec4 backField = nearby(uBackField, uv);
  if (hairField.a < 0.003) return vec2(cover, 0.0);
  vec3 hairHere = hairField.rgb / hairField.a;
  float mixedIn = 0.0;

  // Loose strands and the hairline. Around frizzy or wispy hair the mask is a soft cloud
  // that takes in the background between the strands, and colouring all of it leaves a
  // haze hanging around the hair. So where the mask is unsure, and the hair nearby is a
  // clearly different colour from what is behind it, a pixel that matches the background
  // colour is left alone. Anything that differs from the background is still covered in
  // full, whatever its colour: a grey strand is no more like the wall than a dark one.
  if (matte < 0.92 && backField.a > 0.003) {
    vec3 backHere = backField.rgb / backField.a;
    vec3 apart = hairHere - backHere;
    vec3 off = source - backHere;
    float distance2 = max(dot(apart, apart), 0.0001);
    // 0: exactly the background colour. 1: as far from it as the hair is
    float unlikeBack = sqrt(dot(off, off) / distance2);
    // Only where hair and background are far apart in colour (silver hair against a pale
    // wall is not), and only for pixels that sit right at the background colour
    float distinct = smoothstep(0.05, 0.14, distance2);
    float sure = distinct * (1.0 - smoothstep(0.6, 0.9, matte));
    cover *= 1.0 - sure * (1.0 - smoothstep(0.15, 0.45, unlikeBack));

    // Pixels that are part hair, part something else: the fine hairs of the hairline over
    // skin, a strand across the background. Recolouring only "the hair part" by blending
    // with the old picture would leave the old hair colour in the mix, which shows as a
    // dark outline when the new shade is lighter (a pale one when it is darker). A pixel
    // whose colour lies on the straight line from the local background colour to the local
    // hair colour is such a mix, and its place on that line is its share of hair. The
    // composite swaps that share from the old hair colour to the new.
    float along = clamp(dot(off, apart) / distance2, 0.0, 1.0);
    vec3 stray = off - along * apart;
    float onLine = 1.0 - smoothstep(0.02, 0.1, dot(stray, stray) / distance2);
    mixedIn = along * onLine * distinct * smoothstep(0.03, 0.15, nearHair);
  }

  // A hand in front of the hair. The model usually leaves it out of the mask, but not
  // always, and colour painted on fingers is the one mistake nobody misses. A pixel
  // with the wearer's own skin colouring and roughly their skin's brightness, and
  // unlike the hair around it, is skin. (Much dimmer doesn't count: along the hairline
  // a pixel that is half skin, half dark hair has skin's colouring too, and must still
  // be coloured.) The engine switches this off (uSkin.a = 0) for people whose hair is
  // itself close to their skin colour.
  if (uSkin.a > 0.0) {
    float skinY = max(dot(uSkin.rgb, LUMA), 0.02);
    vec3 tint = source / max(y, 0.02) - uSkin.rgb / skinY;
    float brightness = y / skinY;
    float skinLike = (1.0 - smoothstep(0.012, 0.05, dot(tint, tint)))
      * smoothstep(0.62, 0.8, brightness) * (1.0 - smoothstep(1.7, 2.1, brightness));
    vec3 fromHair = source - hairHere;
    cover *= 1.0 - uSkin.a * skinLike * smoothstep(0.015, 0.05, dot(fromHair, fromHair));
  }

  return vec2(cover, mixedIn);
}`;

/*
 * Precise pipeline: the strand-level mask, the coverage decision, and the
 * steadying against the previous frame. Output: r = coverage, g = brightness,
 * b = share of hair mixed into the rest of the pixel.
 */
export const STEADY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D uFrame;
uniform sampler2D uPrevFrame;
uniform sampler2D uFit;        // the guided filter's rule per region: rgb = slope, a = offset
uniform sampler2D uMomentA;    // a: the model's mask in picture coordinates (its mipmaps average it)
uniform sampler2D uPrevSteady;
uniform float uFitLod;
uniform float uHold;           // share of the previous answer kept where nothing moved (0: no history yet)
${HAIR_COVER}

in vec2 vUv;
out vec4 outSteady;

void main() {
  vec3 source = texture(uFrame, vUv).rgb;

  // The region's rule, applied to this exact pixel: the mask at full sharpness
  vec4 fit = textureLod(uFit, vUv, uFitLod);
  float matte = clamp(dot(fit.rgb, source - 0.5) + fit.a, 0.0, 1.0);
  // The rule is only a guide for where the model is unsure. Where the model sees no hair
  // anywhere near, there is none here, however hair-coloured the pixel. Where it is sure,
  // the pixel is hair whatever its colour: a grey strand, or a glint of light on black hair
  matte = min(matte, smoothstep(0.02, 0.2, textureLod(uMomentA, vUv, 2.0).a));
  matte = max(matte, smoothstep(0.8, 0.95, textureLod(uMomentA, vUv, 0.0).a));
  vec2 decided = hairCover(matte, textureLod(uMomentA, vUv, 1.0).a, source, vUv);
  float cover = decided.x;
  float y = dot(source, LUMA);

  // Has the picture changed here since the last frame? Compared slightly blurred, so
  // camera grain doesn't count as movement
  vec3 change = textureLod(uFrame, vUv, 1.5).rgb - textureLod(uPrevFrame, vUv, 1.5).rgb;
  float moved = smoothstep(0.015, 0.05, abs(dot(change, LUMA)));
  float keep = uHold * (1.0 - moved);

  vec4 before = texture(uPrevSteady, vUv);
  // Colour builds up steadily but leaves at once, e.g. when a hand comes across
  float keepCover = cover < before.r - 0.2 ? 0.0 : keep;
  outSteady = vec4(mix(cover, before.r, keepCover), mix(y, before.g, keep), mix(decided.y, before.b, keep), 1.0);
}`;

export const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D uFrame;
uniform sampler2D uSteady; // precise pipeline: coverage and steadied brightness
uniform sampler2D uMatte;  // fallback pipeline: the mask
uniform int uPrecise;
uniform sampler2D uLut;
uniform sampler2D uZone;
uniform vec4 uZoneRoi;   // maps frame uv into the zone grid (same form as uRoi)
uniform vec2 uScale;     // canvas uv -> frame uv (crops or letterboxes the picture)
uniform float uMirror;
uniform float uSplit;    // canvas x left of which the untouched picture shows (-1: off)
uniform float uStrength;
uniform float uDenoise;  // fallback pipeline only
uniform int uGloss;      // 1: Clear, which keeps the wearer's own colour
uniform float uEdgeCap;  // brightness of their well-lit hair
uniform vec3 uBackdrop;

// Dye shades (uNatural = 1): see natural() below
uniform int uNatural;
uniform float uHairMeanL;  // mean OKLab L of the wearer's hair (alpha-weighted, smoothed over frames)
uniform vec3 uTargetLCh;   // the swatch's mean OKLab lightness, chroma and hue (radians)
uniform float uLift;       // how far the hair's mean lightness moves toward the swatch's
uniform float uChromaFloor;// least share of the swatch's chroma, for the darkest strands
uniform float uMix;        // how much of the recoloured hair replaces the original
uniform float uFeather;    // soft outer edge, in frame pixels
uniform vec2 uTexel;       // one frame pixel, in uv
${HAIR_COVER}

in vec2 vUv;
out vec4 outColour;

// OKLab, as in oklab.ts
vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toGamma(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 toOklab(vec3 rgb) {
  vec3 c = toLinear(clamp(rgb, 0.0, 1.0));
  vec3 lms = pow(vec3(
    dot(c, vec3(0.4122214708, 0.5363325363, 0.0514459929)),
    dot(c, vec3(0.2119034982, 0.6806995451, 0.1073969566)),
    dot(c, vec3(0.0883024619, 0.2817188376, 0.6299787005))
  ), vec3(1.0 / 3.0));
  return vec3(
    dot(lms, vec3(0.2104542553, 0.7936177850, -0.0040720468)),
    dot(lms, vec3(1.9779984951, -2.4285922050, 0.4505937099)),
    dot(lms, vec3(0.0259040371, 0.7827717662, -0.8086757660))
  );
}
vec3 fromOklab(vec3 lab) {
  vec3 lms = vec3(
    lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z,
    lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z,
    lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z
  );
  lms = lms * lms * lms;
  vec3 c = vec3(
    dot(lms, vec3(4.0767416621, -3.3077115913, 0.2309699292)),
    dot(lms, vec3(-1.2684380046, 2.6097574011, -0.3413193965)),
    dot(lms, vec3(-0.0041960863, -0.7034186147, 1.7076147010))
  );
  return clamp(toGamma(max(c, 0.0)), 0.0, 1.0);
}

float skinLikeAt(vec2 uv) {
  vec3 c = textureLod(uFrame, uv, 1.0).rgb;
  float y = max(dot(c, LUMA), 0.02);
  float skinY = max(dot(uSkin.rgb, LUMA), 0.02);
  vec3 tint = c / y - uSkin.rgb / skinY;
  float brightness = y / skinY;
  return (1.0 - smoothstep(0.012, 0.05, dot(tint, tint))) * smoothstep(0.62, 0.8, brightness) * (1.0 - smoothstep(1.7, 2.1, brightness));
}

float coverAt(vec2 uv) {
  return uPrecise == 1 ? texture(uSteady, uv).r : texture(uMatte, uv).r;
}

/*
 * Dye on real hair, by colour transfer in OKLab.
 *  - Lightness: the hair's mean moves uLift of the way toward the swatch's, and every pixel
 *    keeps its own distance from that mean, so contrast and strand texture are untouched
 *    (the contrast factor is 1 and never less).
 *  - Colour: one hue for the whole head, the swatch's, so the tint is even everywhere.
 *    Chroma follows lightness, capped at the swatch's own: dark strands get a weaker
 *    version of the same tint (never below uChromaFloor of it), highlights never more
 *    than the swatch has.
 *  - The result replaces uMix of the original.
 */
vec3 natural(vec3 source) {
  float L0 = toOklab(source).x;
  float L1 = mix(uHairMeanL, uTargetLCh.x, uLift) + (L0 - uHairMeanL);
  float C1 = uTargetLCh.y * clamp(L1 / max(uTargetLCh.x, 1e-3), uChromaFloor, 1.0);
  vec3 recoloured = fromOklab(vec3(L1, C1 * cos(uTargetLCh.z), C1 * sin(uTargetLCh.z)));
  return mix(source, recoloured, uMix);
}

void main() {
  vec2 canvasUv = vUv;
  if (uMirror > 0.5) canvasUv.x = 1.0 - canvasUv.x;
  vec2 uv = (canvasUv - 0.5) * uScale + 0.5;

  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    outColour = vec4(uBackdrop, 1.0);
    return;
  }

  vec3 source = texture(uFrame, uv).rgb;
  float y = dot(source, LUMA);

  float cover;   // how much of this pixel to recolour outright
  float mixedIn; // for the rest of it: the share that is hair mixed into something else
  float yTone;   // the brightness the new colour is laid over
  float detail;  // strand detail to give back afterwards (fallback only)
  if (uPrecise == 1) {
    vec3 steady = texture(uSteady, uv).rgb;
    cover = steady.r;
    yTone = steady.g;
    mixedIn = steady.b;
    detail = 0.0;
  } else {
    vec2 decided = hairCover(texture(uMatte, uv).r, texture(uMatte, uv, 2.0).r, source, uv);
    cover = decided.x;
    mixedIn = decided.y;
    // A slightly blurred copy of the picture: its brightness carries less camera noise
    yTone = mix(y, dot(texture(uFrame, uv, 1.25).rgb, LUMA), uDenoise);
    detail = (y - yTone) / max(yTone, 0.04) * 0.6;
  }
  if (uGloss == 1) mixedIn = 0.0; // Clear changes no colour, so there is nothing to swap

  if (uNatural == 1 && uFeather > 0.0 && max(cover, mixedIn) > 0.004) {
    // Soft outer edge: colour fades out over uFeather pixels toward the edge of the hair,
    // so flyaways blend in, and pulls back further where skin is right next to it
    // (forehead, temples, ears)
    float around = 0.0;
    float skin = 0.0;
    for (int i = 0; i < 8; i++) {
      float angle = float(i) * 0.785398;
      vec2 at = uv + vec2(cos(angle), sin(angle)) * uFeather * uTexel;
      around += coverAt(at);
      if (uSkin.a > 0.0) skin = max(skin, skinLikeAt(at));
    }
    float fade = smoothstep(0.1, 0.8, around / 8.0) * (1.0 - 0.75 * uSkin.a * skin);
    cover *= fade;
    mixedIn *= fade;
  }

  if (vUv.x < uSplit || max(cover, mixedIn) * uStrength < 0.004) {
    outColour = vec4(source, 1.0);
    return;
  }

  // Grey regrowth: zones that are brighter and more washed-out than the rest of the
  // hair are toned down, so they take the colour the way the rest does
  float zone = uGloss == 0 ? texture(uZone, (uv - uZoneRoi.xy) * uZoneRoi.zw).r : 1.0;

  // The part of the pixel that isn't recoloured outright: swap the hair mixed into it
  // from the hair's old colour to its new one
  vec3 rest = source;
  if (mixedIn > 0.004) {
    vec4 hairField = nearby(uHairField, uv);
    if (hairField.a > 0.003) {
      vec3 hairOld = hairField.rgb / hairField.a;
      float yHair = min(dot(hairOld, LUMA) * zone, uEdgeCap);
      vec4 toneHair = texture(uLut, vec2(yHair * (255.0 / 256.0) + 0.5 / 256.0, 0.5));
      vec3 hairNew = uNatural == 1 ? natural(hairOld) : toneHair.rgb;
      rest = clamp(source + mixedIn * uStrength * (hairNew - hairOld), 0.0, 1.0);
    }
  }

  if (uGloss == 0) {
    yTone *= zone;
    // A pixel on the hair's edge is part hair, part background. Against a bright
    // background that mix reads as very bright hair and would be painted as shine,
    // leaving a pale outline; hold edge pixels to ordinary lit-hair brightness instead
    yTone = mix(min(yTone, uEdgeCap), yTone, smoothstep(0.5, 0.95, cover));
  }
  vec4 tone = texture(uLut, vec2(yTone * (255.0 / 256.0) + 0.5 / 256.0, 0.5));

  vec3 colour;
  if (uNatural == 1) {
    colour = natural(source);
  } else if (uGloss == 1) {
    float lift = (tone.a - 0.5) * 0.5;
    colour = source * (1.0 + lift / max(y, 0.04));
  } else {
    colour = tone.rgb * (1.0 + clamp(detail, -0.3, 0.4));
  }

  // Too bright to show: ease toward white rather than clip one channel
  float lightness = dot(colour, LUMA);
  float peak = max(colour.r, max(colour.g, colour.b));
  if (peak > 1.0) {
    colour = mix(vec3(lightness), colour, clamp((1.0 - lightness) / max(peak - lightness, 0.0001), 0.0, 1.0));
  }

  outColour = vec4(mix(rest, clamp(colour, 0.0, 1.0), cover * uStrength), 1.0);
}`;
