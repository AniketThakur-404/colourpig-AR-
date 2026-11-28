/**
 * Hair colour try-on engine.
 *
 * Takes a camera feed or a photo and redraws it on a canvas with the hair in a
 * chosen shade. Everything runs in the browser; no picture leaves the device.
 *
 * Per frame:
 *  1. Crop the picture to a square around the head and run MediaPipe's
 *     multiclass selfie model on it, which marks every pixel as hair, face,
 *     skin, clothes or background. Cropping to the head (instead of feeding
 *     the whole frame) gives the 256px model far more pixels of hair to work
 *     with, so the mask is sharper.
 *  2. Steady the mask against the previous frame so it doesn't shimmer.
 *  3. Measure how bright the wearer's hair and the scene are, their skin tone,
 *     and zones of grey regrowth; rebuild the tone lookup table for the chosen
 *     shade (see tone-curve.ts).
 *  4. Draw: refine the mask down to single strands, hold it still where the
 *     picture is still, recolour and composite (see hair-shaders.ts).
 */

import type { ImageSegmenter, ImageSegmenterResult } from "@mediapipe/tasks-vision";
import {
  COEFFICIENTS_FRAGMENT,
  COMPOSITE_FRAGMENT,
  FIELDS_FRAGMENT,
  MATTE_FRAGMENT,
  MOMENTS_FRAGMENT,
  STEADY_FRAGMENT,
  VERTEX,
} from "./hair-shaders";
import {
  HairShadeProfile,
  Rgb,
  STOP_QUANTILES,
  WORN_TONES_SCENE_WHITE,
  levelFromHairTone,
} from "./shade-profiles";
import { LUT_SIZE, buildToneLut } from "./tone-curve";
import { oklabLightness } from "./oklab";
import { DEFAULT_TUNING, type TryOnTuning } from "./tuning";

/*
 * MediaPipe's runtime and model, served from public/mediapipe.
 *
 * The wasm files are copies of node_modules/@mediapipe/tasks-vision/wasm and must match the
 * installed package version, which is why their folder is named after it. Browsers keep
 * everything under /mediapipe for a year (see next.config.ts), so never replace a file in
 * place: when the package is upgraded, copy its wasm folder into a new version folder and
 * update the path here; give a new model file a new name.
 */
const WASM_PATH = "/mediapipe/0.10.17/wasm";
const MODEL_URL = "/mediapipe/models/selfie_multiclass_256x256.tflite";
const MODEL_BYTES = 16_371_837;

/** The model's input and output size, in pixels */
const MASK = 256;
const MASK_PIXELS = MASK * MASK;
/**
 * How many frames late the camera is shown (one frame is about 33 ms, too little to notice).
 * The wait lets each picture's mask be checked against the next frame before it is drawn.
 */
const CAMERA_DELAY = 1;
/** Mask level (0–255) counted as hair when looking for stray patches */
const BLOB_LEVEL = 77;

/** The crop is divided into ZONES x ZONES cells to find zones of grey regrowth */
const ZONES = 32;
const ZONE_SHIFT = 3; // log2(MASK / ZONES)
const ZONE_CELLS = ZONES * ZONES;

/** Longest side of: the fallback mask, the local-colour pictures, the guided filter's working pictures, the steadied mask */
const MATTE_MAX = 768;
const FIELDS_MAX = 192;
const GUIDE_MAX = 320;
const STEADY_MAX = 1280;
/** Longest side of an uploaded photo, and of the canvas */
const PHOTO_MAX = 1600;
const CANVAS_MAX = 1600;

/** Side of the thumbnail of the whole picture used to judge the scene's light */
const SCENE = 48;
/** The scene's light is re-read on every Nth measuring frame; it changes slowly */
const SCENE_EVERY = 4;

/** Share of the previous frame's mask and brightness kept wherever the picture hasn't moved */
const STEADY_HOLD = 0.72;

const BACKDROP: Rgb = [13 / 255, 21 / 255, 28 / 255]; // obsidian

/** Hair brightness assumed until the wearer's hair has been measured (mid brown) */
const DEFAULT_HAIR = [0.04, 0.08, 0.12, 0.17, 0.24, 0.33, 0.5];

export type TryOnErrorCode =
  | "unsupported"
  | "load-failed"
  | "camera-denied"
  | "camera-missing"
  | "camera-busy"
  | "photo-failed"
  | "context-lost";

export class TryOnError extends Error {
  constructor(
    public code: TryOnErrorCode,
    message: string
  ) {
    super(message);
    this.name = "TryOnError";
  }
}

export interface TryOnFrameInfo {
  /** False when no hair can be found in the picture */
  hairVisible: boolean;
  /** True when the scene is too dark for a trustworthy colour */
  lowLight: boolean;
  /**
   * The depth level the wearer's own hair looks like (1 = black … 10 = lightest blonde),
   * or null before it has been measured. An estimate, good to about a level either way.
   */
  hairLevel: number | null;
}

export interface HairTryOnEngineOptions {
  /** Element the preview canvas is added to (and fills) */
  container: HTMLElement;
  /** A <video> kept in the page (iOS only plays camera video that is in the document) */
  video: HTMLVideoElement;
  /** Accessible description of the preview */
  label?: string;
  onInfo?: (info: TryOnFrameInfo) => void;
  onError?: (error: TryOnError) => void;
}

interface Source {
  kind: "camera" | "photo";
  element: HTMLVideoElement | HTMLCanvasElement;
  width: number;
  height: number;
  mirror: boolean;
}

/** Square crop of the picture, in picture pixels; may overhang the edges */
interface Roi {
  x: number;
  y: number;
  size: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new TryOnError("unsupported", `Shader failed to compile: ${log}`);
  }
  return shader;
}

interface Program {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

function link(gl: WebGL2RenderingContext, fragment: string, uniforms: string[]): Program {
  const program = gl.createProgram()!;
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, "aPosition");
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new TryOnError("unsupported", `Shader failed to link: ${gl.getProgramInfoLog(program)}`);
  }
  const locations: Program["uniforms"] = {};
  for (const name of ["uFlipY", ...uniforms]) locations[name] = gl.getUniformLocation(program, name);
  return { program, uniforms: locations };
}

/** Uniforms of the coverage decision that the steady and composite passes share */
const COVER_UNIFORMS = ["uHairRange", "uHairField", "uBackField", "uSkin", "uThreshold"];

/** Reads the brightness below which each share `qs` of the histogram's weight falls. */
function quantiles(hist: ArrayLike<number>, total: number, qs: readonly number[], out: Float32Array | number[]) {
  let seen = 0;
  let q = 0;
  for (let bin = 0; bin < 256 && q < qs.length; bin++) {
    const count = hist[bin];
    while (q < qs.length && seen + count >= qs[q] * total) {
      out[q++] = (bin + (count > 0 ? (qs[q - 1] * total - seen) / count : 0)) / 255;
    }
    seen += count;
  }
  while (q < qs.length) out[q++] = 1;
}

const sameRoi = (a: Roi, b: Roi) => a.x === b.x && a.y === b.y && a.size === b.size;

/** Shrinks a square mask by `radius` pixels (a minimum filter), in place. */
function minFilter(values: Uint8Array, scratch: Uint8Array, radius: number) {
  const pick = Math.min;
  // Rows, then columns
  for (let pass = 0; pass < 2; pass++) {
    const from = pass === 0 ? values : scratch;
    const to = pass === 0 ? scratch : values;
    for (let a = 0; a < MASK; a++) {
      for (let b = 0; b < MASK; b++) {
        let best = from[pass === 0 ? a * MASK + b : b * MASK + a];
        for (let k = Math.max(0, b - radius); k <= Math.min(MASK - 1, b + radius); k++) {
          best = pick(best, from[pass === 0 ? a * MASK + k : k * MASK + a]);
        }
        to[pass === 0 ? a * MASK + b : b * MASK + a] = best;
      }
    }
  }
}

/** Moves a square grid of values (`side` x `side`) from one crop of the picture to another. */
function recrop(from: Float32Array, to: Float32Array, side: number, previous: Roi, next: Roi, outside: number) {
  const step = next.size / previous.size;
  const originX = ((next.x - previous.x) / previous.size) * side + 0.5 * step - 0.5;
  const originY = ((next.y - previous.y) / previous.size) * side + 0.5 * step - 0.5;
  for (let y = 0, i = 0; y < side; y++) {
    const fy = originY + y * step;
    const iy = Math.floor(fy);
    const ty = fy - iy;
    for (let x = 0; x < side; x++, i++) {
      const fx = originX + x * step;
      const ix = Math.floor(fx);
      if (ix < 0 || iy < 0 || ix >= side - 1 || iy >= side - 1) {
        to[i] = outside;
        continue;
      }
      const tx = fx - ix;
      const o = iy * side + ix;
      const upper = from[o] + (from[o + 1] - from[o]) * tx;
      const lower = from[o + side] + (from[o + side + 1] - from[o + side]) * tx;
      to[i] = upper + (lower - upper) * ty;
    }
  }
}

async function fetchModel(onProgress?: (fraction: number) => void): Promise<Uint8Array> {
  const response = await fetch(MODEL_URL);
  if (!response.ok) throw new Error(`Model request failed (${response.status})`);
  if (!response.body) return new Uint8Array(await response.arrayBuffer());

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(Math.min(0.97, received / MODEL_BYTES));
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** Opens a photo upright (phones store rotation separately from the pixels). */
async function decodePhoto(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // Older Safari, and formats only <img> can open
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      if (!image.naturalWidth) throw new Error("empty image");
      return image;
    } catch {
      throw new TryOnError("photo-failed", "That file couldn't be opened as a photo.");
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

export class HairTryOnEngine {
  private canvas: HTMLCanvasElement;
  private video: HTMLVideoElement;
  private onInfo?: (info: TryOnFrameInfo) => void;
  private onError?: (error: TryOnError) => void;

  // ---- graphics. Texture units: 0 picture, 1 model mask, 2 tone table, 3 fallback mask or
  // guided-filter rule, 4 grey zones, 5 hair colours, 6 background colours, 7 previous picture,
  // 8 steadied mask, 9-12 guided-filter moments
  private gl: WebGL2RenderingContext | null = null;
  /** True when the strand-level, steadied pipeline can run (needs half-float render targets) */
  private precise = false;
  private matteProgram: Program | null = null;
  private momentsProgram: Program | null = null;
  private coefficientsProgram: Program | null = null;
  private steadyProgram: Program | null = null;
  private fieldsProgram!: Program;
  private compositeProgram!: Program;
  private triangle: WebGLBuffer | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private textures: WebGLTexture[] = [];
  private framebuffers: WebGLFramebuffer[] = [];

  /**
   * The last three camera pictures; frameIndex is the newest. The camera is shown one
   * frame late (CAMERA_DELAY), so the mask of the picture on screen can also be checked
   * against the frame that came after it.
   */
  private frameTexes: WebGLTexture[] = [];
  private frameIndex = 0;
  private framesLoaded = 0;
  private maskTex: WebGLTexture | null = null;
  private lutTex: WebGLTexture | null = null;
  private zoneTex: WebGLTexture | null = null;
  private matteTex: WebGLTexture | null = null;
  private matteFbo: WebGLFramebuffer | null = null;
  private matteWidth = 0;
  private matteHeight = 0;
  private hairFieldTex: WebGLTexture | null = null;
  private backFieldTex: WebGLTexture | null = null;
  private fieldsFbo: WebGLFramebuffer | null = null;
  private fieldsWidth = 0;
  private fieldsHeight = 0;
  private momentTexes: WebGLTexture[] = [];
  private momentsFbo: WebGLFramebuffer | null = null;
  private fitTex: WebGLTexture | null = null;
  private fitFbo: WebGLFramebuffer | null = null;
  private guideWidth = 0;
  private guideHeight = 0;
  /** The steadied mask now and one frame ago; steadyIndex says which is which */
  private steadyTexes: WebGLTexture[] = [];
  private steadyFbos: WebGLFramebuffer[] = [];
  private steadyIndex = 0;
  private steadyWidth = 0;
  private steadyHeight = 0;
  /** True until the steadied mask has one frame of history to blend with */
  private steadyFresh = true;

  private segmenter: ImageSegmenter | null = null;
  private loading: Promise<void> | null = null;
  private hairIndex = 1;
  private faceIndex = 3;
  private bodyIndex = 2;
  private lastTimestamp = 0;

  private source: Source | null = null;
  private stream: MediaStream | null = null;
  private frameCallback = 0;
  private animation = 0;
  private usesVideoFrames = false;
  private destroyed = false;
  /** Counts camera / photo requests, so a slow one can tell it has been superseded */
  private request = 0;

  // The head crop fed to the model
  private roiCanvas: HTMLCanvasElement;
  private roiCtx: CanvasRenderingContext2D;
  private roi: Roi = { x: 0, y: 0, size: 1 };
  /** The crop the current mask was made from (the crop itself may already have moved on) */
  private maskRoi: Roi = this.roi;
  /** Part of the crop that holds real picture (the rest is padding past the frame edge) */
  private filled = { x0: 0, y0: 0, x1: MASK, y1: MASK };
  private lostFrames = 0;

  // The model's hair mask, steadied over time
  private matte = new Float32Array(MASK_PIXELS);
  private matteScratch = new Float32Array(MASK_PIXELS);
  private maskBytes = new Uint8Array(MASK_PIXELS);
  private hasMatte = false;
  /** The mask of the camera picture waiting to be shown, and the crop it was made in */
  private pendingMatte = new Float32Array(MASK_PIXELS);
  private pendingRoi: Roi = this.roi;
  private hasPending = false;
  private lookAhead = new Float32Array(MASK_PIXELS);

  // What was measured about the wearer's hair
  private hairTones = Float32Array.from(DEFAULT_HAIR);
  private measured = new Float32Array(STOP_QUANTILES.length);
  private hasHairTones = false;
  /** Darkest and brightest hair tones as photographed (before grey zones are toned down) */
  private hairRange = [DEFAULT_HAIR[0], DEFAULT_HAIR[DEFAULT_HAIR.length - 1]];
  private hairHist = new Float32Array(256);

  // ...their skin
  private skin: Rgb = [0.75, 0.57, 0.47];
  private hasSkin = false;
  /** Share of the wearer's own hair that could be mistaken for their skin by colour */
  private skinLookalike = 0;

  // ...and the scene's light, read from a thumbnail of the whole picture
  private sceneCanvas: HTMLCanvasElement;
  private sceneCtx: CanvasRenderingContext2D;
  private sceneHist = new Uint32Array(256);
  private sceneCountdown = 0;
  private exposure = 1;
  private tint: Rgb = [1, 1, 1];
  private brightFloor = 200;

  // Per-zone sums of hair brightness, colourfulness and weight, and the resulting tone-down
  private zoneLuma = new Float32Array(ZONE_CELLS);
  private zoneChroma = new Float32Array(ZONE_CELLS);
  private zoneWeight = new Float32Array(ZONE_CELLS);
  private zoneScratch = new Float32Array(ZONE_CELLS);
  private zoneGain = new Float32Array(ZONE_CELLS).fill(1);
  private zoneGainScratch = new Float32Array(ZONE_CELLS);
  private zoneBytes = new Uint8Array(ZONE_CELLS).fill(255);
  private zoneRoi: Roi = this.roi;
  private zoneStale = true;

  // The tone table, eased toward its target so shade changes cross-fade
  private profile: HairShadeProfile | null = null;
  private lutTarget = new Float32Array(LUT_SIZE * 4);
  private lutCurrent = new Float32Array(LUT_SIZE * 4);
  private lutBytes = new Uint8Array(LUT_SIZE * 4);
  private lutStale = true;
  private lutSettled = false;
  private lutSnap = true;
  private denoise = 0;

  private strength = 0;
  private tuning: TryOnTuning = { ...DEFAULT_TUNING };
  /** Mean OKLab lightness of the wearer's hair, weighted by the mask and smoothed over frames */
  private hairMeanL = 0.25;
  private hasHairMean = false;
  private blobLabels = new Int32Array(MASK_PIXELS);
  private blobStack = new Int32Array(MASK_PIXELS);
  /** The model's face-skin mask (0–255, shrunk), in the crop faceRoi */
  private faceMask = new Uint8Array(MASK_PIXELS);
  private faceScratch = new Uint8Array(MASK_PIXELS);
  private faceRoi: Roi = this.roi;
  private hasFace = false;
  private split = -1;
  private frame = 0;
  private frameStale = true;
  private matteStale = true;
  private drawQueued = false;

  private info: TryOnFrameInfo = { hairVisible: true, lowLight: false, hairLevel: null };
  private infoVotes = { noHair: 0, lowLight: 0 };
  /** Running estimate of the wearer's depth level, before rounding */
  private hairLevel: number | null = null;

  constructor(options: HairTryOnEngineOptions) {
    // A canvas keeps one graphics context for life, so each engine makes its own canvas
    // rather than inheriting one whose context an earlier engine has already released
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", options.label ?? "Hair colour try-on preview");
    options.container.appendChild(this.canvas);
    this.video = options.video;
    this.onInfo = options.onInfo;
    this.onError = options.onError;

    // Both are read back to measure from, so they are kept in main memory
    this.roiCanvas = document.createElement("canvas");
    this.roiCanvas.width = this.roiCanvas.height = MASK;
    this.roiCtx = this.roiCanvas.getContext("2d", { willReadFrequently: true, alpha: false })!;
    this.roiCtx.imageSmoothingQuality = "medium";
    this.sceneCanvas = document.createElement("canvas");
    this.sceneCanvas.width = this.sceneCanvas.height = SCENE;
    this.sceneCtx = this.sceneCanvas.getContext("2d", { willReadFrequently: true, alpha: false })!;

    this.canvas.addEventListener("webglcontextlost", this.handleContextLost);
  }

  /** Downloads the model and gets the graphics pipeline ready. Safe to call more than once. */
  load(onProgress?: (fraction: number) => void): Promise<void> {
    if (!this.loading) {
      this.loading = this.initialise(onProgress).catch((error) => {
        this.loading = null;
        throw error instanceof TryOnError
          ? error
          : new TryOnError("load-failed", error instanceof Error ? error.message : String(error));
      });
    }
    return this.loading;
  }

  private async initialise(onProgress?: (fraction: number) => void) {
    this.setUpGraphics();

    const [vision, model] = await Promise.all([import("@mediapipe/tasks-vision"), fetchModel(onProgress)]);
    const fileset = await vision.FilesetResolver.forVisionTasks(WASM_PATH);
    const create = (delegate: "GPU" | "CPU") =>
      vision.ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: model, delegate },
        runningMode: "VIDEO",
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });

    let segmenter: ImageSegmenter;
    try {
      segmenter = await create("GPU");
      // Some phone GPUs run the model without complaint but hand back blank or garbage masks
      if (!this.answersSensibly(segmenter)) {
        segmenter.close();
        segmenter = await create("CPU");
      }
    } catch {
      // Phones and browsers without usable GPU inference fall back to the processor
      segmenter = await create("CPU");
    }

    if (this.destroyed) {
      segmenter.close();
      return;
    }

    const labels = segmenter.getLabels().map((label) => label.toLowerCase());
    const find = (name: string, fallback: number) => {
      const index = labels.indexOf(name);
      return index >= 0 ? index : fallback;
    };
    this.hairIndex = find("hair", 1);
    this.bodyIndex = find("body-skin", 2);
    this.faceIndex = find("face-skin", 3);
    this.segmenter = segmenter;
    onProgress?.(1);
  }

  /**
   * Start-up check: shown an empty grey picture, a working segmenter is about 90% sure
   * all of it is background (the same in Chrome, Firefox and Safari's engine). A broken
   * one answers with zeros or nonsense.
   */
  private answersSensibly(segmenter: ImageSegmenter): boolean {
    const background = segmenter.getLabels().findIndex((label) => label.toLowerCase() === "background");
    const blank = document.createElement("canvas");
    blank.width = blank.height = MASK;
    const ctx = blank.getContext("2d");
    if (background < 0 || !ctx) return true;
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, MASK, MASK);

    let sureness = NaN;
    const timestamp = Math.max(performance.now(), this.lastTimestamp + 1);
    this.lastTimestamp = timestamp;
    try {
      segmenter.segmentForVideo(blank, timestamp, (result) => {
        const values = result.confidenceMasks?.[background]?.getAsFloat32Array();
        if (!values?.length) return;
        let sum = 0;
        let count = 0;
        for (let i = 0; i < values.length; i += 16, count++) sum += values[i];
        sureness = sum / count;
      });
    } catch {
      return false;
    }
    return sureness > 0.6; // false for NaN as well
  }

  private setUpGraphics() {
    if (this.gl) return;
    const gl = this.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new TryOnError("unsupported", "This browser can't run the try-on (WebGL 2 is unavailable).");
    this.gl = gl;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    // One triangle that covers the whole target
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.triangle = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.triangle);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.precise = this.canDrawToHalfFloat(gl);

    this.fieldsProgram = link(gl, FIELDS_FRAGMENT, ["uFrame", "uMatte", "uPick"]);
    this.compositeProgram = link(gl, COMPOSITE_FRAGMENT, [
      "uFrame",
      "uSteady",
      "uMatte",
      "uPrecise",
      "uLut",
      "uZone",
      "uZoneRoi",
      "uScale",
      "uMirror",
      "uSplit",
      "uStrength",
      "uDenoise",
      "uGloss",
      "uEdgeCap",
      "uBackdrop",
      "uNatural",
      "uHairMeanL",
      "uTargetLCh",
      "uLift",
      "uChromaFloor",
      "uLighten",
      "uMix",
      "uFeather",
      "uTexel",
      ...COVER_UNIFORMS,
    ]);
    if (this.precise) {
      this.momentsProgram = link(gl, MOMENTS_FRAGMENT, ["uFrame", "uMask", "uRoi"]);
      this.coefficientsProgram = link(gl, COEFFICIENTS_FRAGMENT, [
        "uMomentA",
        "uMomentB",
        "uMomentC",
        "uMomentD",
        "uWindowLod",
        "uEpsilon",
      ]);
      this.steadyProgram = link(gl, STEADY_FRAGMENT, [
        "uFrame",
        "uPrevFrame",
        "uFit",
        "uMomentA",
        "uPrevSteady",
        "uFitLod",
        "uHold",
        ...COVER_UNIFORMS,
      ]);
    } else {
      this.matteProgram = link(gl, MATTE_FRAGMENT, [
        "uFrame",
        "uMask",
        "uRoi",
        "uMaskTexel",
        "uGuideLod",
        "uColourFalloff",
      ]);
    }

    const mipmapped = gl.LINEAR_MIPMAP_LINEAR;
    this.frameTexes = Array.from({ length: CAMERA_DELAY + 2 }, () => this.makeTexture(gl, mipmapped));
    this.maskTex = this.makeTexture(gl, gl.LINEAR);
    this.zoneTex = this.makeTexture(gl, gl.LINEAR);
    this.lutTex = this.makeTexture(gl, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, LUT_SIZE, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.lutBytes);

    // Everything drawn into starts as a 2x2 blank, so it can be sampled before its first frame
    const blank = (texture: WebGLTexture, halfFloat: boolean) => {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      if (halfFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 2, 2, 0, gl.RGBA, gl.HALF_FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(16));
      gl.generateMipmap(gl.TEXTURE_2D);
      return texture;
    };
    this.hairFieldTex = blank(this.makeTexture(gl, mipmapped), false);
    this.backFieldTex = blank(this.makeTexture(gl, mipmapped), false);
    this.fieldsFbo = this.makeFramebuffer(gl);
    this.fieldsWidth = this.fieldsHeight = 2;

    if (this.precise) {
      for (let i = 0; i < 4; i++) this.momentTexes.push(blank(this.makeTexture(gl, mipmapped), true));
      this.momentsFbo = this.makeFramebuffer(gl);
      this.fitTex = blank(this.makeTexture(gl, mipmapped), true);
      this.fitFbo = this.makeFramebuffer(gl);
      this.guideWidth = this.guideHeight = 2;
      for (let i = 0; i < 2; i++) {
        const texture = this.makeTexture(gl, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 2, 2, 0, gl.RGBA, gl.HALF_FLOAT, null);
        this.steadyTexes.push(texture);
        const fbo = this.makeFramebuffer(gl);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        this.steadyFbos.push(fbo);
      }
      this.steadyWidth = this.steadyHeight = 2;
    } else {
      this.matteTex = this.makeTexture(gl, mipmapped);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 2, 2, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(4));
      gl.generateMipmap(gl.TEXTURE_2D);
      this.matteFbo = this.makeFramebuffer(gl);
      this.matteWidth = this.matteHeight = 2;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private makeTexture(gl: WebGL2RenderingContext, minFilter: number): WebGLTexture {
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.push(texture);
    return texture;
  }

  private makeFramebuffer(gl: WebGL2RenderingContext): WebGLFramebuffer {
    const framebuffer = gl.createFramebuffer()!;
    this.framebuffers.push(framebuffer);
    return framebuffer;
  }

  /**
   * The strand-level pipeline keeps fine fractions (a mask rule, a running average), which
   * 8-bit pictures are too coarse for. This checks the device can draw into half-float
   * pictures, four at a time, and build their smaller copies.
   */
  private canDrawToHalfFloat(gl: WebGL2RenderingContext): boolean {
    if (!gl.getExtension("EXT_color_buffer_float") && !gl.getExtension("EXT_color_buffer_half_float")) return false;
    if ((gl.getParameter(gl.MAX_DRAW_BUFFERS) as number) < 4) return false;

    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 4, 4, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    while (gl.getError() !== gl.NO_ERROR); // clear anything left over
    gl.generateMipmap(gl.TEXTURE_2D);
    const mipmaps = gl.getError() === gl.NO_ERROR;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    return complete && mipmaps;
  }

  /** Sets the shade to wear; null shows the untouched picture. */
  setShade(profile: HairShadeProfile | null) {
    if (profile === this.profile) return;
    // Clear (gloss) and colour tables mean different things, so don't blend between them
    if (!profile || !this.profile || profile.kind !== this.profile.kind) {
      this.lutSnap = true;
      this.strength = Math.min(this.strength, 0.35);
    }
    this.profile = profile;
    this.lutStale = true;
    this.requestDraw();
  }

  /** Changes how dye shades are laid over the hair (see tuning.ts); unset values keep theirs. */
  setTuning(tuning: Partial<TryOnTuning>) {
    this.tuning = { ...this.tuning, ...tuning };
    this.lutStale = true;
    this.requestDraw();
  }

  /** Shows the untouched picture left of `position` (0–1 across the canvas); null turns it off. */
  setCompare(position: number | null) {
    this.split = position === null ? -1 : clamp(position, 0, 1);
    this.requestDraw();
  }

  /** Call when the canvas element changes size. */
  resize() {
    this.requestDraw();
  }

  /** Resolves true once the camera is live, false if a newer request replaced this one. */
  async startCamera(facing: "user" | "environment" = "user"): Promise<boolean> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new TryOnError("camera-missing", "This browser can't open the camera here.");
    }
    this.stopSource();
    const request = ++this.request;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        throw new TryOnError("camera-denied", "Camera access was blocked.");
      }
      if (name === "NotFoundError" || name === "OverconstrainedError") {
        throw new TryOnError("camera-missing", "No camera was found.");
      }
      throw new TryOnError("camera-busy", "The camera couldn't be started.");
    }

    if (this.destroyed || request !== this.request) {
      stream.getTracks().forEach((track) => track.stop());
      return false;
    }

    this.stream = stream;
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      if (this.stream === stream) {
        this.stopSource();
        this.onError?.(new TryOnError("camera-busy", "The camera stopped."));
      }
    });
    const video = this.video;
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    try {
      await video.play();
    } catch {
      /* A newer play() call (or the modal closing) interrupted this one */
    }
    if (this.destroyed || this.stream !== stream) return false;

    if (!video.videoWidth) {
      await new Promise<void>((resolve) => video.addEventListener("loadeddata", () => resolve(), { once: true }));
      if (this.destroyed || this.stream !== stream) return false;
    }

    // Phones report which way the lens points; laptops don't, and theirs faces the user
    const facingNow = stream.getVideoTracks()[0]?.getSettings().facingMode;
    this.setSource({
      kind: "camera",
      element: video,
      width: video.videoWidth,
      height: video.videoHeight,
      mirror: facingNow ? facingNow === "user" : facing === "user",
    });

    await this.load();
    if (this.destroyed || this.stream !== stream) return false;
    this.usesVideoFrames = typeof video.requestVideoFrameCallback === "function";
    this.scheduleFrame();
    return true;
  }

  /** Tries the shade on a still photo instead of the camera. Resolves like startCamera. */
  async showPhoto(file: Blob): Promise<boolean> {
    const request = ++this.request;
    const picture = await decodePhoto(file);

    const scale = Math.min(1, PHOTO_MAX / Math.max(picture.width, picture.height));
    const photo = document.createElement("canvas");
    photo.width = Math.max(1, Math.round(picture.width * scale));
    photo.height = Math.max(1, Math.round(picture.height * scale));
    const ctx = photo.getContext("2d", { alpha: false })!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(picture, 0, 0, photo.width, photo.height);
    if ("close" in picture) picture.close();

    await this.load();
    if (this.destroyed || request !== this.request) return false;

    this.stopSource();
    this.setSource({ kind: "photo", element: photo, width: photo.width, height: photo.height, mirror: false });

    // Three passes: the first finds the head, the next two re-run on the tightened crop
    for (let pass = 0; pass < 3; pass++) this.analyse(false, true);
    this.requestDraw();
    return true;
  }

  /** Stops the camera (and its indicator light). */
  stopSource() {
    if (this.frameCallback) {
      if (this.usesVideoFrames) this.video.cancelVideoFrameCallback(this.frameCallback);
      else cancelAnimationFrame(this.frameCallback);
      this.frameCallback = 0;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
      this.video.srcObject = null;
    }
    this.source = null;
  }

  /** The picture as shown, without the compare split. Photos are saved uncropped. */
  capture(): Promise<Blob> {
    const source = this.source;
    if (!this.gl || !source) return Promise.reject(new TryOnError("photo-failed", "Nothing to capture yet."));

    const { width, height } = this.canvas;
    const split = this.split;
    this.split = -1;
    if (source.kind === "photo") {
      this.canvas.width = source.width;
      this.canvas.height = source.height;
    }
    this.draw(false);

    // toBlob copies the pixels now and encodes later, so the canvas can be put back straight away
    const result = new Promise<Blob>((resolve, reject) => {
      this.canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new TryOnError("photo-failed", "The photo couldn't be saved."))),
        "image/jpeg",
        0.92
      );
    });

    this.split = split;
    if (source.kind === "photo") {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.draw(false);
    return result;
  }

  destroy() {
    this.destroyed = true;
    this.stopSource();
    cancelAnimationFrame(this.animation);
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.segmenter?.close();
    this.segmenter = null;

    const gl = this.gl;
    if (gl) {
      for (const texture of this.textures) gl.deleteTexture(texture);
      for (const framebuffer of this.framebuffers) gl.deleteFramebuffer(framebuffer);
      gl.deleteBuffer(this.triangle);
      gl.deleteVertexArray(this.vao);
      // Any of these is missing if set-up failed part-way
      for (const made of [
        this.matteProgram,
        this.momentsProgram,
        this.coefficientsProgram,
        this.steadyProgram,
        this.fieldsProgram,
        this.compositeProgram,
      ]) {
        gl.deleteProgram(made?.program ?? null);
      }
      // Hand the graphics memory back now rather than whenever the browser gets round to it
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      this.gl = null;
    }
    this.canvas.remove();
  }

  // ---------------------------------------------------------------- frames

  private handleContextLost = (event: Event) => {
    event.preventDefault();
    this.stopSource();
    this.onError?.(new TryOnError("context-lost", "The graphics context was lost."));
  };

  private setSource(source: Source) {
    this.source = source;
    this.roi = this.fullRoi(source);
    this.hasMatte = false;
    this.hasPending = false;
    this.hasFace = false;
    this.hasHairMean = false;
    this.hasHairTones = false;
    this.hasSkin = false;
    this.skinLookalike = 0;
    this.sceneCountdown = 0;
    this.zoneGain.fill(1);
    this.zoneBytes.fill(255);
    this.zoneStale = true;
    this.lostFrames = 0;
    this.strength = 0;
    this.framesLoaded = 0;
    this.steadyFresh = true;
    this.frameStale = true;
    this.matteStale = true;
    this.lutStale = true;
    this.lutSnap = true;
    this.infoVotes = { noHair: 0, lowLight: 0 };
    this.hairLevel = null;
    // Whatever was known belonged to the previous picture; the first measurement reports afresh
    this.info = { hairVisible: true, lowLight: false, hairLevel: null };
  }

  private scheduleFrame() {
    if (this.destroyed || this.source?.kind !== "camera") return;
    this.frameCallback = this.usesVideoFrames
      ? this.video.requestVideoFrameCallback(this.onCameraFrame)
      : requestAnimationFrame(this.onCameraFrame);
  }

  private onCameraFrame = () => {
    this.frameCallback = 0;
    const source = this.source;
    if (this.destroyed || !source || source.kind !== "camera") return;

    const video = this.video;
    if (video.readyState >= 2 && video.videoWidth > 0) {
      // Rotating a phone swaps the camera's width and height
      if (video.videoWidth !== source.width || video.videoHeight !== source.height) {
        this.setSource({ ...source, width: video.videoWidth, height: video.videoHeight });
      }
      try {
        // Copy the frame to the GPU before analysing it. Analysis can take longer than one
        // camera frame, and copying afterwards would show a newer picture than the mask was
        // made from, leaving colour trailing behind the hair whenever the head moves.
        this.uploadFrame(this.source ?? source);
        this.analyse(true, this.frame % 2 === 0);
        this.draw(true);
      } catch (error) {
        this.onError?.(
          error instanceof TryOnError
            ? error
            : new TryOnError("load-failed", error instanceof Error ? error.message : String(error))
        );
        return;
      }
      this.frame++;
    }
    this.scheduleFrame();
  };

  /** Redraws a still photo (camera frames redraw themselves). */
  private requestDraw() {
    if (this.drawQueued || this.destroyed || !this.gl) return;
    if (this.source?.kind !== "photo") return;
    this.drawQueued = true;
    this.animation = requestAnimationFrame(() => {
      this.drawQueued = false;
      if (this.destroyed || this.source?.kind !== "photo") return;
      this.draw(true);
      // Keep going until the fade-in and any shade cross-fade have finished
      if (!this.lutSettled || this.strength < 0.999) this.requestDraw();
    });
  }

  // -------------------------------------------------------------- analysis

  private fullRoi(source: Source): Roi {
    const size = Math.max(source.width, source.height);
    return { x: (source.width - size) / 2, y: (source.height - size) / 2, size };
  }

  /** Runs the model on the head crop, then updates the mask, the crop and (optionally) the measurements. */
  private analyse(steady: boolean, measure: boolean) {
    const source = this.source;
    const segmenter = this.segmenter;
    if (!source || !segmenter) return;

    // Draw the crop; anything past the picture's edge stays black
    const { roi, roiCtx } = this;
    const scale = MASK / roi.size;
    const sx0 = Math.max(0, roi.x);
    const sy0 = Math.max(0, roi.y);
    const sx1 = Math.min(source.width, roi.x + roi.size);
    const sy1 = Math.min(source.height, roi.y + roi.size);
    roiCtx.fillStyle = "#000";
    roiCtx.fillRect(0, 0, MASK, MASK);
    if (sx1 - sx0 < 1 || sy1 - sy0 < 1) return;
    const dx = (sx0 - roi.x) * scale;
    const dy = (sy0 - roi.y) * scale;
    const dw = (sx1 - sx0) * scale;
    const dh = (sy1 - sy0) * scale;
    roiCtx.drawImage(source.element, sx0, sy0, sx1 - sx0, sy1 - sy0, dx, dy, dw, dh);
    this.filled = {
      x0: clamp(Math.ceil(dx), 0, MASK),
      y0: clamp(Math.ceil(dy), 0, MASK),
      x1: clamp(Math.floor(dx + dw), 0, MASK),
      y1: clamp(Math.floor(dy + dh), 0, MASK),
    };

    // MediaPipe needs timestamps that always increase
    const timestamp = Math.max(performance.now(), this.lastTimestamp + 1);
    this.lastTimestamp = timestamp;
    segmenter.segmentForVideo(this.roiCanvas, timestamp, (result) => this.readMasks(result, source, steady, measure));
  }

  /** The masks are only valid inside this callback, so everything that needs them happens here. */
  private readMasks(result: ImageSegmenterResult, source: Source, steady: boolean, measure: boolean) {
    const masks = result.confidenceMasks;
    const hairMask = masks?.[this.hairIndex];
    if (!masks || !hairMask || hairMask.width !== MASK || hairMask.height !== MASK) return;

    const hair = hairMask.getAsFloat32Array();
    // Each mask read back stalls the GPU for a few milliseconds, so the face and body masks
    // are fetched only on the frames that measure (every other camera frame)
    const face = measure ? masks[this.faceIndex]?.getAsFloat32Array() : undefined;
    const matte = this.matte;
    const bytes = this.maskBytes;
    const blend = steady && this.hasMatte;

    let x0 = MASK;
    let y0 = MASK;
    let x1 = -1;
    let y1 = -1;
    let hairPixels = 0;

    for (let y = 0, i = 0; y < MASK; y++) {
      for (let x = 0; x < MASK; x++, i++) {
        const now = hair[i] > 0 ? Math.min(hair[i], 1) : 0; // also drops NaN
        let value = now;
        if (blend) {
          // Follow a big change at once (something moved, or came in front of the hair) and
          // smooth small ones (the model wavering). The smoothing can be firm because the
          // drawing passes re-fit the mask's edge to each new picture anyway.
          const before = matte[i];
          const change = now - before;
          const size = change < 0 ? -change : change;
          if (size <= 0.35) value = before + change * (0.3 + size * 2);
        }
        matte[i] = value;

        const isHair = now > 0.5;
        if (isHair) hairPixels++;
        if (isHair || (face !== undefined && face[i] > 0.5)) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    this.hasMatte = true;
    this.matteStale = true;

    if (source.kind === "camera" && this.hasPending) {
      // The picture on screen is the previous frame. Its mask is evened out with this
      // newer one wherever the two nearly agree (the model wavering), and kept as it is
      // where they differ a lot (the head moved), so the colour stays on the hair.
      const shown = this.pendingMatte;
      let next = matte;
      if (!sameRoi(this.roi, this.pendingRoi)) {
        recrop(matte, this.lookAhead, MASK, this.roi, this.pendingRoi, 0);
        next = this.lookAhead;
      }
      for (let i = 0; i < MASK_PIXELS; i++) {
        const before = shown[i];
        const change = next[i] - before;
        const value = change <= 0.35 && change >= -0.35 ? before + change * 0.5 : before;
        bytes[i] = (value * 255 + 0.5) | 0;
      }
      this.maskRoi = this.pendingRoi;
    } else {
      for (let i = 0; i < MASK_PIXELS; i++) bytes[i] = (matte[i] * 255 + 0.5) | 0;
      this.maskRoi = this.roi;
    }
    if (source.kind === "camera") {
      this.pendingMatte.set(matte);
      this.pendingRoi = this.roi;
      this.hasPending = true;
    }

    this.dropStrayBlobs(bytes);
    this.protectSkin(bytes, face);

    const pixelsPerMaskPixel = (this.roi.size / MASK) ** 2;
    const hairShare = (hairPixels * pixelsPerMaskPixel) / (source.width * source.height);

    if (measure) {
      const body = masks[this.bodyIndex]?.getAsFloat32Array();
      this.measure(source, face, body, !steady);
      this.report(hairShare > 0.004, steady);
      this.trackHead(source, x0, y0, x1, y1, hairPixels, steady);
    }
  }

  /**
   * Removes patches of "hair" that aren't joined to the head of hair: a dark coat collar,
   * a picture on the wall, a shadow. Anything much smaller than the largest connected
   * area is cleared from the mask that is drawn.
   */
  private dropStrayBlobs(bytes: Uint8Array) {
    const labels = this.blobLabels.fill(0);
    const stack = this.blobStack;
    const sizes: number[] = [0];
    for (let start = 0; start < MASK_PIXELS; start++) {
      if (labels[start] || bytes[start] < BLOB_LEVEL) continue;
      const label = sizes.length;
      let size = 0;
      let top = 0;
      const visit = (j: number) => {
        if (!labels[j] && bytes[j] >= BLOB_LEVEL) {
          labels[j] = label;
          stack[top++] = j;
        }
      };
      visit(start);
      while (top > 0) {
        const i = stack[--top];
        size++;
        const x = i % MASK;
        // Four neighbours: left, right, up, down
        if (x > 0) visit(i - 1);
        if (x < MASK - 1) visit(i + 1);
        if (i >= MASK) visit(i - MASK);
        if (i < MASK_PIXELS - MASK) visit(i + MASK);
      }
      sizes.push(size);
    }
    if (sizes.length <= 2) return;
    const smallest = Math.max(...sizes) * 0.15;
    for (let i = 0; i < MASK_PIXELS; i++) {
      if (labels[i] && sizes[labels[i]] < smallest) bytes[i] = 0;
    }
  }

  /**
   * Keeps the drawn mask off face skin: wherever the model is surer of face skin (its face
   * mask shrunk by about 3 px) than of hair, the hair mask is held to 1 − that certainty.
   * Hair lying on the forehead, which the model marks as hair, keeps its colour.
   */
  private protectSkin(bytes: Uint8Array, face: Float32Array | undefined) {
    // The face mask arrives every other frame; it is kept, in the crop it was made for
    if (face) {
      const keep = this.faceMask;
      for (let i = 0; i < MASK_PIXELS; i++) keep[i] = (face[i] > 0 ? Math.min(face[i], 1) : 0) * 255;
      const unit = this.roi.size / MASK; // camera pixels per mask pixel
      minFilter(keep, this.faceScratch, Math.max(1, Math.round(3 / unit)));
      this.faceRoi = this.roi;
      this.hasFace = true;
    }
    if (!this.hasFace || !sameRoi(this.faceRoi, this.maskRoi)) return;
    const skin = this.faceMask;
    for (let i = 0; i < MASK_PIXELS; i++) {
      if (skin[i] > bytes[i]) bytes[i] = Math.min(bytes[i], 255 - skin[i]);
    }
  }

  /** Measures the wearer's hair (brightness, grey zones), their skin tone, and the scene's light. */
  private measure(source: Source, face: Float32Array | undefined, body: Float32Array | undefined, instant: boolean) {
    const { x0, y0, x1, y1 } = this.filled;
    if (x1 - x0 < 8 || y1 - y0 < 8) return;

    const pixels = this.roiCtx.getImageData(0, 0, MASK, MASK).data;
    const matte = this.matte;
    const hairHist = this.hairHist.fill(0);
    const zoneLuma = this.zoneLuma.fill(0);
    const zoneChroma = this.zoneChroma.fill(0);
    const zoneWeight = this.zoneWeight.fill(0);
    let hairWeight = 0;

    // Skin tone, and how much of the hair could pass for it. Judged the way the shader does:
    // by colouring (colour divided by brightness), with brightness allowed to differ.
    const skinWas = this.skin;
    const skinWasLevel = Math.max(skinWas[0] * 0.299 + skinWas[1] * 0.587 + skinWas[2] * 0.114, 0.02) * 255;
    let skinR = 0;
    let skinG = 0;
    let skinB = 0;
    let skinCount = 0;
    let hairCount = 0;
    let lookalikes = 0;

    // Every second pixel each way is plenty for stable statistics
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const i = y * MASK + x;
        const r = pixels[i * 4];
        const g = pixels[i * 4 + 1];
        const b = pixels[i * 4 + 2];
        const level = (r * 77 + g * 150 + b * 29) >> 8;

        const m = matte[i];
        if (m > 0.7) {
          hairHist[level] += m;
          hairWeight += m;
          const zone = (y >> ZONE_SHIFT) * ZONES + (x >> ZONE_SHIFT);
          zoneLuma[zone] += m * level;
          zoneChroma[zone] += (m * (Math.max(r, g, b) - Math.min(r, g, b))) / (level + 12);
          zoneWeight[zone] += m;

          if (this.hasSkin && m > 0.9) {
            hairCount++;
            const brightness = level / skinWasLevel;
            if (brightness > 0.71 && brightness < 1.9) {
              const own = Math.max(level, 5);
              const dr = r / own - (skinWas[0] * 255) / skinWasLevel;
              const dg = g / own - (skinWas[1] * 255) / skinWasLevel;
              const db = b / own - (skinWas[2] * 255) / skinWasLevel;
              if (dr * dr + dg * dg + db * db < 0.03) lookalikes++;
            }
          }
        } else if (face !== undefined && face[i] > 0.8) {
          skinR += r;
          skinG += g;
          skinB += b;
          skinCount++;
        }
      }
    }

    const ease = instant ? 1 : 0.1;
    let pigmentedTone = 0;

    if (hairWeight > 24) {
      // The 30th percentile stands for the wearer's pigmented hair: unlike the median, it
      // stays put even when a third or more of the hair has gone grey
      const raw = [0, 0, 0];
      quantiles(hairHist, hairWeight, [0.03, 0.3, 0.97], raw);
      const settle = this.hasHairTones ? ease : 1;
      this.hairRange[0] += (raw[0] - this.hairRange[0]) * settle;
      this.hairRange[1] += (raw[2] - this.hairRange[1]) * settle;
      pigmentedTone = raw[1];
      // Cameras often crush black hair to pure black; measured against that, any hair
      // catching a little light would look many times brighter and be taken for grey
      this.findGreyZones(Math.max(raw[1] * 255, 14), instant);

      // The hair's brightness once grey zones are toned down: this is what the shade is laid over
      const zoneGain = this.zoneGain;
      hairHist.fill(0);
      // Also the hair's mean OKLab lightness, weighted by the mask: the dye blend moves it
      // toward the swatch's and keeps every pixel's distance from it
      let sumL = 0;
      let sumWeight = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = y * MASK + x;
          const m = matte[i];
          if (m <= 0.3) continue;
          const r = pixels[i * 4];
          const g = pixels[i * 4 + 1];
          const b = pixels[i * 4 + 2];
          sumL += m * oklabLightness(r, g, b);
          sumWeight += m;
          if (m <= 0.7) continue;
          const level = (r * 77 + g * 150 + b * 29) >> 8;
          hairHist[(level * zoneGain[(y >> ZONE_SHIFT) * ZONES + (x >> ZONE_SHIFT)] + 0.5) | 0] += m;
        }
      }
      if (sumWeight > 0) {
        // Smoothed over frames (each new measurement counts 20%), so the hair doesn't pulse
        const mean = sumL / sumWeight;
        this.hairMeanL = this.hasHairMean && !instant ? this.hairMeanL * 0.8 + mean * 0.2 : mean;
        this.hasHairMean = true;
      }
      quantiles(hairHist, hairWeight, STOP_QUANTILES, this.measured);
      for (let i = 0; i < this.hairTones.length; i++) {
        this.hairTones[i] += (this.measured[i] - this.hairTones[i]) * settle;
      }
      this.hasHairTones = true;
      this.lutStale = true;
    }

    if (skinCount > 30) {
      const settle = this.hasSkin ? ease : 1;
      const now = [skinR / skinCount / 255, skinG / skinCount / 255, skinB / skinCount / 255];
      for (let c = 0; c < 3; c++) this.skin[c] += (now[c] - this.skin[c]) * settle;
      this.hasSkin = true;
    }
    if (hairCount > 60) {
      // Eased slowly: a hand resting on the hair for a moment mustn't talk the engine out of
      // telling skin from hair
      this.skinLookalike += (lookalikes / hairCount - this.skinLookalike) * (instant ? 1 : 0.04);
    }

    if (instant || --this.sceneCountdown <= 0) {
      this.sceneCountdown = SCENE_EVERY;
      this.measureScene(source, face, body, instant);
    }

    if (pigmentedTone > 0) {
      const level = levelFromHairTone(pigmentedTone / this.exposure);
      this.hairLevel = this.hairLevel === null ? level : this.hairLevel + (level - this.hairLevel) * ease;
    }
  }

  /**
   * How well lit the scene is, and the colour of its light. Read from a thumbnail of the
   * whole picture rather than from the head crop: the crop moves and resizes as the head
   * does, and the shade's brightness would shift with it.
   */
  private measureScene(source: Source, face: Float32Array | undefined, body: Float32Array | undefined, instant: boolean) {
    this.sceneCtx.drawImage(source.element, 0, 0, SCENE, SCENE);
    const pixels = this.sceneCtx.getImageData(0, 0, SCENE, SCENE).data;
    const hist = this.sceneHist.fill(0);
    const roi = this.roi;
    const matte = this.matte;
    const brightFloor = this.brightFloor;
    let lightR = 0;
    let lightG = 0;
    let lightB = 0;
    let lightCount = 0;

    for (let y = 0; y < SCENE; y++) {
      // Where this thumbnail row falls in the head crop's mask, if at all
      const my = Math.floor(((((y + 0.5) / SCENE) * source.height - roi.y) / roi.size) * MASK);
      for (let x = 0; x < SCENE; x++) {
        const o = (y * SCENE + x) * 4;
        const r = pixels[o];
        const g = pixels[o + 1];
        const b = pixels[o + 2];
        const level = (r * 77 + g * 150 + b * 29) >> 8;
        hist[level]++;

        if (level < brightFloor || r >= 250 || g >= 250 || b >= 250) continue;
        // Bright, unclipped surfaces that aren't hair or skin show the colour of the light
        const mx = Math.floor(((((x + 0.5) / SCENE) * source.width - roi.x) / roi.size) * MASK);
        if (mx >= 0 && mx < MASK && my >= 0 && my < MASK) {
          const i = my * MASK + mx;
          if (matte[i] > 0.1 || (face !== undefined && face[i] > 0.2) || (body !== undefined && body[i] > 0.2)) continue;
        }
        lightR += r;
        lightG += g;
        lightB += b;
        lightCount++;
      }
    }

    const scene = [0, 0];
    quantiles(hist, SCENE * SCENE, [0.85, 0.97], scene);
    this.brightFloor = Math.round(scene[0] * 255);

    const ease = instant ? 1 : 0.2;
    // Light the shade as the scene is lit: brighter where the scene has brighter surfaces than
    // the photos the shade tones came from, dimmer where it has none
    const exposure = clamp(Math.sqrt(scene[1] / WORN_TONES_SCENE_WHITE), 0.75, 1.15);
    // Small wobbles (the camera's own exposure hunting) are ignored outright
    if (instant || Math.abs(exposure - this.exposure) > 0.02) {
      this.exposure += (exposure - this.exposure) * ease;
      this.lutStale = true;
    }

    if (lightCount > 12) {
      const mean = (lightR * 0.299 + lightG * 0.587 + lightB * 0.114) / lightCount || 1;
      const sums = [lightR, lightG, lightB];
      for (let c = 0; c < 3; c++) {
        // Lean only gently toward the light's colour; a coloured wall shouldn't dye the hair
        const cast = 1 + (clamp(sums[c] / lightCount / mean, 0.88, 1.12) - 1) * 0.6;
        if (instant || Math.abs(cast - this.tint[c]) > 0.01) {
          this.tint[c] += (cast - this.tint[c]) * ease;
          this.lutStale = true;
        }
      }
    }

    // Judged by the brightest things in view, not the average: a head of black hair
    // filling the frame makes the picture dark overall without the light being poor
    const dim = scene[1] < 0.42;
    this.infoVotes.lowLight = clamp(this.infoVotes.lowLight + (dim ? 2 : -2), 0, 12);
  }

  /**
   * Grey regrowth shows up as a zone of hair that is brighter than the wearer's
   * pigmented hair and either more washed-out (grey in brown or blonde hair) or
   * far brighter than lighting alone would make it (grey in black hair, which
   * has no colour to wash out). Left alone it would simply be painted as
   * highlights and stay visibly lighter, which is not what a grey coverage
   * colour does. Each such zone gets a tone-down factor that brings it most of
   * the way to the brightness of the rest of the hair. Zones that are only a
   * little brighter and still colourful (plain lighting) are barely changed.
   */
  private findGreyZones(pigmentedLevel: number, instant: boolean) {
    // Blur each sum across neighbouring cells (twice) so the factor changes smoothly over the head
    const blurred = (values: Float32Array): Float32Array => {
      let from = values;
      let to: Float32Array = this.zoneScratch;
      for (let pass = 0; pass < 2; pass++) {
        for (let y = 0, i = 0; y < ZONES; y++) {
          for (let x = 0; x < ZONES; x++, i++) {
            let sum = 0;
            for (let dy = -1; dy <= 1; dy++) {
              const yy = y + dy;
              if (yy < 0 || yy >= ZONES) continue;
              for (let dx = -1; dx <= 1; dx++) {
                const xx = x + dx;
                if (xx >= 0 && xx < ZONES) sum += from[yy * ZONES + xx];
              }
            }
            to[i] = sum;
          }
        }
        const swap = from;
        from = to;
        to = swap;
      }
      // After two passes the result is back in `values` itself
      return from;
    };
    const luma = blurred(this.zoneLuma);
    const chroma = blurred(this.zoneChroma);
    const weight = blurred(this.zoneWeight);

    // How colourful the wearer's pigmented hair is, judged from their darker zones
    let chromaSum = 0;
    let chromaWeight = 0;
    for (let i = 0; i < ZONE_CELLS; i++) {
      if (weight[i] > 0 && luma[i] <= pigmentedLevel * 1.25 * weight[i]) {
        chromaSum += chroma[i];
        chromaWeight += weight[i];
      }
    }
    const baseChroma = chromaWeight > 0 ? chromaSum / chromaWeight : 0;

    const ease = instant ? 1 : 0.2;
    for (let i = 0; i < ZONE_CELLS; i++) {
      let gain = 1;
      if (weight[i] > 0.001 && pigmentedLevel > 1) {
        const brighter = luma[i] / weight[i] / pigmentedLevel;
        if (brighter > 1) {
          // Evidence of grey: washed-out colour (only meaningful when the wearer's hair has colour)...
          let grey = 0;
          if (baseChroma > 0.08) {
            const t = clamp((0.8 - chroma[i] / weight[i] / baseChroma) / 0.35, 0, 1);
            grey = t * t * (3 - 2 * t);
          }
          // ...or a jump in brightness too big to be lighting
          const jump = clamp((brighter - 2.2) / 1.8, 0, 1);
          grey = Math.max(grey, jump * jump * (3 - 2 * jump));
          // Grey in dark hair is several times brighter than the hair around it, and is pulled almost all the way down
          const stark = clamp((brighter - 3) / 2, 0, 1);
          gain = Math.pow(brighter, -(0.25 + 0.45 * grey + 0.15 * stark * stark * (3 - 2 * stark)));
        }
      }
      const value = this.zoneGain[i] + (gain - this.zoneGain[i]) * ease;
      this.zoneGain[i] = value;
      this.zoneBytes[i] = (value * 255 + 0.5) | 0;
    }
    this.zoneRoi = this.roi;
    this.zoneStale = true;
  }

  /** Tells the UI when hair goes missing or the light is poor, without flickering between states. */
  private report(hairVisible: boolean, steady: boolean) {
    const votes = this.infoVotes;
    votes.noHair = steady ? clamp(votes.noHair + (hairVisible ? -2 : 1), 0, 30) : hairVisible ? 0 : 30;
    // The level is reported in whole steps, and only changes once the estimate is clearly past the halfway point
    let hairLevel = this.info.hairLevel;
    if (this.hairLevel !== null && (hairLevel === null || Math.abs(this.hairLevel - hairLevel) > 0.7)) {
      hairLevel = Math.round(this.hairLevel);
    }
    const next: TryOnFrameInfo = {
      hairVisible: this.info.hairVisible ? votes.noHair < 24 : votes.noHair < 8,
      lowLight: steady ? (this.info.lowLight ? votes.lowLight > 3 : votes.lowLight > 9) : votes.lowLight > 0,
      hairLevel,
    };
    if (
      next.hairVisible !== this.info.hairVisible ||
      next.lowLight !== this.info.lowLight ||
      next.hairLevel !== this.info.hairLevel
    ) {
      this.info = next;
      this.onInfo?.(next);
    }
  }

  /**
   * Keeps the crop centred on the head. The model answers slightly differently for every
   * crop, so each move shows as a small jump in the mask; the crop is therefore generous
   * and moves only when the head has clearly left its middle or changed size.
   */
  private trackHead(source: Source, x0: number, y0: number, x1: number, y1: number, hairPixels: number, steady: boolean) {
    const current = this.roi;

    if (hairPixels < 40 || x1 < x0) {
      // Lost the head: after a moment, look at the whole picture again
      const full = this.fullRoi(source);
      if (++this.lostFrames > 6 && current.size !== full.size) this.setRoi(full, steady);
      return;
    }
    this.lostFrames = 0;

    const unit = current.size / MASK;
    const left = current.x + x0 * unit;
    const top = current.y + y0 * unit;
    const right = current.x + (x1 + 1) * unit;
    const bottom = current.y + (y1 + 1) * unit;
    const centreX = (left + right) / 2;
    const centreY = (top + bottom) / 2;
    const size = clamp(
      Math.max(right - left, bottom - top) * 1.55,
      Math.min(source.width, source.height) * 0.3,
      Math.max(source.width, source.height)
    );

    // Hair running off the crop while there is more picture beyond it
    const margin = 6;
    const cutOff =
      (x0 < margin && current.x > 0.5) ||
      (y0 < margin && current.y > 0.5) ||
      (x1 > MASK - 1 - margin && current.x + current.size < source.width - 0.5) ||
      (y1 > MASK - 1 - margin && current.y + current.size < source.height - 0.5);

    const drift = Math.max(
      Math.abs(centreX - (current.x + current.size / 2)),
      Math.abs(centreY - (current.y + current.size / 2))
    );
    const zoom = size / current.size;

    if (cutOff || drift > current.size * 0.13 || zoom < 0.74 || zoom > 1.28) {
      this.setRoi({ x: centreX - size / 2, y: centreY - size / 2, size }, steady);
    }
  }

  private setRoi(next: Roi, keepHistory: boolean) {
    const previous = this.roi;
    this.roi = next;
    if (!keepHistory || !this.hasMatte) return;

    // Carry the steadied mask over to the new crop so the next frame can still blend with it
    recrop(this.matte, this.matteScratch, MASK, previous, next, 0);
    [this.matte, this.matteScratch] = [this.matteScratch, this.matte];

    // ...and the grey zones, which would otherwise sit over the wrong part of the head
    // until they had been measured afresh
    recrop(this.zoneGain, this.zoneGainScratch, ZONES, this.zoneRoi, next, 1);
    [this.zoneGain, this.zoneGainScratch] = [this.zoneGainScratch, this.zoneGain];
    for (let i = 0; i < ZONE_CELLS; i++) this.zoneBytes[i] = (this.zoneGain[i] * 255 + 0.5) | 0;
    this.zoneRoi = next;
    this.zoneStale = true;
  }

  // --------------------------------------------------------------- drawing

  /** Copies the picture to the GPU, with smaller copies (mipmaps) that give cheap blurs. */
  private uploadFrame(source: Source) {
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;
    // The other picture becomes "the previous frame", which movement is judged against
    this.frameIndex = (this.frameIndex + 1) % this.frameTexes.length;
    this.framesLoaded++;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTexes[this.frameIndex]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source.element);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.frameStale = false;
  }

  private syncCanvasSize() {
    const canvas = this.canvas;
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    if (!cssWidth || !cssHeight) return;
    const density = Math.min(window.devicePixelRatio || 1, 2, CANVAS_MAX / Math.max(cssWidth, cssHeight));
    const width = Math.max(1, Math.round(cssWidth * density));
    const height = Math.max(1, Math.round(cssHeight * density));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  private updateLut(gl: WebGL2RenderingContext) {
    if (this.lutStale && this.profile) {
      const { denoise } = buildToneLut(
        this.profile,
        { hair: this.hairTones, exposure: this.exposure, tint: this.tint },
        this.lutTarget
      );
      this.denoise = denoise;
      this.lutStale = false;
      this.lutSettled = false;
    }
    if (this.lutSettled) return;

    const ease = this.lutSnap ? 1 : 0.3;
    this.lutSnap = false;
    let furthest = 0;
    for (let i = 0; i < this.lutCurrent.length; i++) {
      const gap = this.lutTarget[i] - this.lutCurrent[i];
      const value = this.lutCurrent[i] + gap * ease;
      this.lutCurrent[i] = value;
      this.lutBytes[i] = (value * 255 + 0.5) | 0;
      if (gap > furthest) furthest = gap;
      else if (-gap > furthest) furthest = -gap;
    }
    this.lutSettled = furthest * (1 - ease) < 0.003;

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, LUT_SIZE, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.lutBytes);
  }

  /** Size of a working picture: the source's shape, with its longest side capped. */
  private fit(source: Source, longest: number): [number, number] {
    const shrink = Math.min(1, longest / Math.max(source.width, source.height));
    return [Math.max(2, Math.round(source.width * shrink)), Math.max(2, Math.round(source.height * shrink))];
  }

  private setRoiUniforms(gl: WebGL2RenderingContext, uniforms: Program["uniforms"], source: Source) {
    const roi = this.maskRoi;
    gl.uniform1i(uniforms.uMask, 1);
    gl.uniform4f(uniforms.uRoi, roi.x / source.width, roi.y / source.height, source.width / roi.size, source.height / roi.size);
  }

  /** The inputs of the coverage decision (see HAIR_COVER in hair-shaders.ts). */
  private setCoverUniforms(gl: WebGL2RenderingContext, uniforms: Program["uniforms"]) {
    gl.uniform2f(uniforms.uHairRange, this.hairRange[0], this.hairRange[1]);
    gl.uniform1f(uniforms.uThreshold, this.tuning.maskThreshold);
    gl.uniform1i(uniforms.uHairField, 5);
    gl.uniform1i(uniforms.uBackField, 6);
    // Skin is told from hair by colour only while almost none of the wearer's own hair
    // would be mistaken for it (fair or red hair can be skin-coloured; then the model decides alone)
    const trust = this.hasSkin ? 1 - clamp((this.skinLookalike - 0.01) / 0.03, 0, 1) : 0;
    gl.uniform4f(uniforms.uSkin, this.skin[0], this.skin[1], this.skin[2], trust);
  }

  /** Fallback pipeline: sharpen the model's mask onto the real hairline. */
  private drawMatte(gl: WebGL2RenderingContext, source: Source) {
    const [width, height] = this.fit(source, MATTE_MAX);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.matteTex);
    if (width !== this.matteWidth || height !== this.matteHeight) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, null);
      this.matteWidth = width;
      this.matteHeight = height;
    }
    // Unbind before rendering into it
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.matteFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.matteTex, 0);
    gl.viewport(0, 0, width, height);

    const { program, uniforms } = this.matteProgram!;
    const roi = this.maskRoi;
    gl.useProgram(program);
    gl.uniform1f(uniforms.uFlipY, 0);
    gl.uniform1i(uniforms.uFrame, 0);
    this.setRoiUniforms(gl, uniforms, source);
    gl.uniform2f(uniforms.uMaskTexel, roi.size / MASK / source.width, roi.size / MASK / source.height);
    gl.uniform1f(uniforms.uGuideLod, Math.max(0.5, Math.log2(roi.size / MASK) - 0.5));
    gl.uniform1f(uniforms.uColourFalloff, 60);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Smaller copies of the mask, so the next pass can read it at low resolution cleanly
    gl.bindTexture(gl.TEXTURE_2D, this.matteTex);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /**
   * Precise pipeline: the guided filter. Works out, region by region, the rule that turns
   * the picture's colours into the model's mask (see MOMENTS and COEFFICIENTS).
   */
  private drawGuide(gl: WebGL2RenderingContext, source: Source) {
    const [width, height] = this.fit(source, GUIDE_MAX);
    const resized = width !== this.guideWidth || height !== this.guideHeight;
    const allocate = (texture: WebGLTexture) => {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    };

    // Step 1: colour, mask and their products
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.momentsFbo);
    this.momentTexes.forEach((texture, index) => {
      gl.activeTexture(gl.TEXTURE9 + index);
      if (resized) {
        allocate(texture);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + index, gl.TEXTURE_2D, texture, 0);
      }
      // Not bound for reading while it is being drawn into
      gl.bindTexture(gl.TEXTURE_2D, null);
    });
    if (resized) {
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3]);
    }
    gl.viewport(0, 0, width, height);
    {
      const { program, uniforms } = this.momentsProgram!;
      gl.useProgram(program);
      gl.uniform1f(uniforms.uFlipY, 0);
      gl.uniform1i(uniforms.uFrame, 0);
      this.setRoiUniforms(gl, uniforms, source);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    // The mipmaps are the blur: each level averages a wider window
    this.momentTexes.forEach((texture, index) => {
      gl.activeTexture(gl.TEXTURE9 + index);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.generateMipmap(gl.TEXTURE_2D);
    });

    // Step 2: the rule per window
    gl.activeTexture(gl.TEXTURE3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fitFbo);
    if (resized) {
      allocate(this.fitTex!);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fitTex, 0);
      this.guideWidth = width;
      this.guideHeight = height;
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    {
      const { program, uniforms } = this.coefficientsProgram!;
      gl.useProgram(program);
      gl.uniform1f(uniforms.uFlipY, 0);
      gl.uniform1i(uniforms.uMomentA, 9);
      gl.uniform1i(uniforms.uMomentB, 10);
      gl.uniform1i(uniforms.uMomentC, 11);
      gl.uniform1i(uniforms.uMomentD, 12);
      // A window reaching the tuning's radius (in camera pixels) each way; mipmap level k
      // averages about 2^k working pixels each way. uEpsilon is how much colour difference
      // it takes before the mask starts following the picture.
      const radius = (this.tuning.guidedRadius * width) / source.width;
      gl.uniform1f(uniforms.uWindowLod, clamp(Math.log2(Math.max(radius, 1)), 0, 4));
      gl.uniform1f(uniforms.uEpsilon, 0.001);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.fitTex);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /** The colour of the hair and of its surroundings, region by region (see FIELDS_FRAGMENT). */
  private drawFields(gl: WebGL2RenderingContext, source: Source) {
    const [width, height] = this.fit(source, FIELDS_MAX);
    const fields = [this.hairFieldTex, this.backFieldTex];

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fieldsFbo);
    if (width !== this.fieldsWidth || height !== this.fieldsHeight) {
      fields.forEach((field, index) => {
        gl.activeTexture(gl.TEXTURE5 + index);
        gl.bindTexture(gl.TEXTURE_2D, field);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + index, gl.TEXTURE_2D, field, 0);
      });
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      this.fieldsWidth = width;
      this.fieldsHeight = height;
    }
    // Neither picture may be bound for reading while it is being drawn into
    fields.forEach((_, index) => {
      gl.activeTexture(gl.TEXTURE5 + index);
      gl.bindTexture(gl.TEXTURE_2D, null);
    });

    gl.viewport(0, 0, width, height);
    const { program, uniforms } = this.fieldsProgram;
    gl.useProgram(program);
    gl.uniform1f(uniforms.uFlipY, 0);
    gl.uniform1i(uniforms.uFrame, 0);
    // "Certainly hair" and "certainly not" are judged from the model's mask: the fallback's
    // sharpened copy, or the copy the guided filter keeps alongside the picture's colours
    if (this.precise) {
      gl.uniform1i(uniforms.uMatte, 9);
      gl.uniform4f(uniforms.uPick, 0, 0, 0, 1);
    } else {
      gl.uniform1i(uniforms.uMatte, 3);
      gl.uniform4f(uniforms.uPick, 1, 0, 0, 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // The mipmaps are the blur: each level averages a wider area
    fields.forEach((field, index) => {
      gl.activeTexture(gl.TEXTURE5 + index);
      gl.bindTexture(gl.TEXTURE_2D, field);
      gl.generateMipmap(gl.TEXTURE_2D);
    });
  }

  /**
   * Precise pipeline: the strand-level mask and the coverage decision for this frame,
   * blended with the last frame's wherever the picture hasn't moved (see STEADY_FRAGMENT).
   */
  private drawSteady(gl: WebGL2RenderingContext, source: Source) {
    const [width, height] = this.fit(source, STEADY_MAX);
    if (width !== this.steadyWidth || height !== this.steadyHeight) {
      gl.activeTexture(gl.TEXTURE8);
      for (const texture of this.steadyTexes) {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
      }
      this.steadyWidth = width;
      this.steadyHeight = height;
      this.steadyFresh = true;
    }

    const next = 1 - this.steadyIndex;
    gl.activeTexture(gl.TEXTURE8);
    gl.bindTexture(gl.TEXTURE_2D, this.steadyTexes[this.steadyIndex]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.steadyFbos[next]);
    gl.viewport(0, 0, width, height);

    const { program, uniforms } = this.steadyProgram!;
    gl.useProgram(program);
    gl.uniform1f(uniforms.uFlipY, 0);
    gl.uniform1i(uniforms.uFrame, 0);
    gl.uniform1i(uniforms.uPrevFrame, 7);
    gl.uniform1i(uniforms.uFit, 3);
    gl.uniform1i(uniforms.uMomentA, 9);
    gl.uniform1i(uniforms.uPrevSteady, 8);
    gl.uniform1f(uniforms.uFitLod, 1);
    // A photo, or the first camera frame, has nothing earlier to blend with
    gl.uniform1f(uniforms.uHold, this.steadyFresh || source.kind !== "camera" ? 0 : STEADY_HOLD);
    this.setCoverUniforms(gl, uniforms);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.steadyIndex = next;
    this.steadyFresh = false;
  }

  private draw(animate: boolean) {
    const gl = this.gl;
    const source = this.source;
    if (!gl || !source || gl.isContextLost()) return;

    if (animate) this.syncCanvasSize();
    const canvas = this.canvas;

    gl.bindVertexArray(this.vao);

    if (this.frameStale) this.uploadFrame(source);
    // The camera is shown CAMERA_DELAY frames late (a photo never is), and so is the
    // "previous frame" that movement is judged against
    const count = this.frameTexes.length;
    const late = source.kind === "camera" ? Math.min(CAMERA_DELAY, Math.max(0, this.framesLoaded - 1)) : 0;
    const shownIndex = (this.frameIndex + count - late) % count;
    const pictureNow = this.frameTexes[shownIndex];
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, pictureNow);
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(
      gl.TEXTURE_2D,
      this.framesLoaded > late + 1 ? this.frameTexes[(shownIndex + count - 1) % count] : pictureNow
    );

    if (this.matteStale && this.hasMatte) {
      this.matteStale = false;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, MASK, MASK, 0, gl.RED, gl.UNSIGNED_BYTE, this.maskBytes);

      if (this.precise) this.drawGuide(gl, source);
      else this.drawMatte(gl, source);
      this.drawFields(gl, source);
      if (this.precise) this.drawSteady(gl, source);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    this.updateLut(gl);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.zoneTex);
    if (this.zoneStale) {
      this.zoneStale = false;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, ZONES, ZONES, 0, gl.RED, gl.UNSIGNED_BYTE, this.zoneBytes);
    }
    if (animate) this.strength += (1 - this.strength) * 0.16;
    const wearing = this.profile !== null && this.hasMatte;

    // Final pass: recolour and composite
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.precise ? this.fitTex : this.matteTex);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.hairFieldTex);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.backFieldTex);
    gl.activeTexture(gl.TEXTURE8);
    // (The fallback has no steadied mask; its sampler still needs something to point at)
    gl.bindTexture(gl.TEXTURE_2D, this.precise ? this.steadyTexes[this.steadyIndex] : pictureNow);

    const { program, uniforms } = this.compositeProgram;
    gl.useProgram(program);
    gl.uniform1f(uniforms.uFlipY, 1);
    gl.uniform1i(uniforms.uFrame, 0);
    gl.uniform1i(uniforms.uLut, 2);
    gl.uniform1i(uniforms.uMatte, 3);
    gl.uniform1i(uniforms.uSteady, 8);
    gl.uniform1i(uniforms.uPrecise, this.precise ? 1 : 0);
    this.setCoverUniforms(gl, uniforms);

    // The camera fills the canvas (cropping the overflow); a photo is shown whole
    const canvasAspect = canvas.width / canvas.height;
    const sourceAspect = source.width / source.height;
    const wider = canvasAspect > sourceAspect;
    const fill = source.kind === "camera";
    const ratio = wider ? sourceAspect / canvasAspect : canvasAspect / sourceAspect;
    if (wider === fill) gl.uniform2f(uniforms.uScale, 1, fill ? ratio : 1 / ratio);
    else gl.uniform2f(uniforms.uScale, fill ? ratio : 1 / ratio, 1);

    gl.uniform1f(uniforms.uMirror, source.mirror ? 1 : 0);
    gl.uniform1f(uniforms.uSplit, this.split);
    gl.uniform1f(uniforms.uStrength, wearing ? this.strength : 0);
    gl.uniform1f(uniforms.uDenoise, this.denoise);
    gl.uniform1i(uniforms.uGloss, this.profile?.kind === "gloss" ? 1 : 0);
    gl.uniform1f(uniforms.uEdgeCap, this.hairTones[4]);
    gl.uniform1i(uniforms.uZone, 4);
    const zones = this.zoneRoi;
    gl.uniform4f(
      uniforms.uZoneRoi,
      zones.x / source.width,
      zones.y / source.height,
      source.width / zones.size,
      source.height / zones.size
    );
    gl.uniform3f(uniforms.uBackdrop, BACKDROP[0], BACKDROP[1], BACKDROP[2]);
    this.setNaturalUniforms(gl, uniforms, source);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** The inputs of the dye blend (see `natural` in hair-shaders.ts); Clear doesn't use it. */
  private setNaturalUniforms(gl: WebGL2RenderingContext, uniforms: Program["uniforms"], source: Source) {
    const profile = this.profile;
    const swatch = profile?.kind === "colour" && profile.natural === true ? profile.swatch : undefined;
    gl.uniform1i(uniforms.uNatural, swatch ? 1 : 0);
    if (!swatch) return;
    const tuning = this.tuning;

    gl.uniform1f(uniforms.uHairMeanL, this.hairMeanL);
    gl.uniform3f(uniforms.uTargetLCh, swatch.L, swatch.C, swatch.h);
    gl.uniform1f(uniforms.uLift, tuning.lift);
    gl.uniform1f(uniforms.uChromaFloor, tuning.chromaFloor);
    gl.uniform1f(uniforms.uLighten, profile?.kind === "colour" ? (profile.lighten ?? 0) : 0);
    gl.uniform1f(uniforms.uMix, tuning.strength);
    gl.uniform1f(uniforms.uFeather, tuning.feather);
    gl.uniform2f(uniforms.uTexel, 1 / source.width, 1 / source.height);
  }
}
