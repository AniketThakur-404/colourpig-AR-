"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  Camera,
  CameraOff,
  ChevronsLeftRight,
  Download,
  ImageUp,
  LoaderCircle,
  ScanFace,
  Share2,
  ShieldCheck,
  ShoppingBag,
  SquareSplitHorizontal,
  Sun,
  SwitchCamera,
  X,
} from "lucide-react";
import Image from "@/components/ui/image";
import { ShadeSwatch } from "@/components/product/shade-swatch";
import { findShade } from "@/data/catalog";
import { canTryOnShade } from "./hair-try-on";
import { useCatalog } from "@/context/catalog-context";
import { useStore } from "@/context/store-context";
import { HairTryOnEngine, TryOnError, TryOnErrorCode, TryOnFrameInfo } from "@/lib/ar/hair-try-on-engine";
import { getHairShadeProfile, loadSwatchProfile } from "@/lib/ar/shade-profiles";
import { DEFAULT_TUNING, TUNING_SLIDERS, type TryOnTuning } from "@/lib/ar/tuning";

export interface HairTryOnModalProps {
  /** Shade to start on, e.g. "shade-4" */
  initialShadeId: string;
  /** Shade of the product page underneath, if any; its "Details" link is left out */
  pageShadeId?: string;
  onClose: () => void;
}

type View = "intro" | "starting" | "camera" | "photo" | "error";
type Facing = "user" | "environment";

const PROBLEMS: Record<TryOnErrorCode, { title: string; body: string; offerPhoto: boolean }> = {
  "camera-denied": {
    title: "Camera access is blocked",
    body: "Allow the camera for this site in your browser's address bar, then try again. You can also try the shade on a photo.",
    offerPhoto: true,
  },
  "camera-missing": {
    title: "No camera found",
    body: "Connect a camera and try again, or try the shade on a photo.",
    offerPhoto: true,
  },
  "camera-busy": {
    title: "The camera couldn't start",
    body: "Another app may be using it. Close that app and try again, or try the shade on a photo.",
    offerPhoto: true,
  },
  "photo-failed": {
    title: "That photo couldn't be opened",
    body: "Choose a JPG or PNG photo and try again.",
    offerPhoto: true,
  },
  unsupported: {
    title: "Try-on isn't supported here",
    body: "Open this page in a current version of Chrome, Safari, Edge or Firefox.",
    offerPhoto: false,
  },
  "load-failed": {
    title: "The try-on couldn't load",
    body: "Check your connection and try again.",
    offerPhoto: false,
  },
  "context-lost": {
    title: "The preview stopped",
    body: "Your device paused the graphics. Start the try-on again.",
    offerPhoto: false,
  },
};

const STAGE_BUTTON =
  "h-11 px-4 rounded-full bg-black/45 hover:bg-black/60 backdrop-blur-md border border-white/20 text-white text-[11px] font-mono font-bold uppercase tracking-wider flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";

const NOTHING_SEEN: TryOnFrameInfo = { hairVisible: true, lowLight: false, hairLevel: null };

/** Depth level of a shade (2 = black … 9 = very light blonde), carried in its formula: No.1 Black is formula 2.0 */
const shadeLevel = (shade: { formula: string; code: string }) =>
  Math.round(parseFloat(shade.formula) || parseInt(shade.code.replace(/\D/g, "")) || 4);

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function HairTryOnModal({ initialShadeId, pageShadeId, onClose }: HairTryOnModalProps) {
  const store = useStore();
  const { shades: allShades } = useCatalog();
  // No.7, No.8 and No.9 are left out of the try-on (see canTryOnShade)
  const shades = allShades.filter((s) => canTryOnShade(s.id));

  const [shadeId, setShadeId] = useState(initialShadeId);
  const shade = findShade(shades, shadeId) ?? shades[0];
  const isClear = getHairShadeProfile(shade).kind === "gloss";
  const kit = shade.kits.find((k) => k.id === "starter-system") ?? shade.kits[0];

  const [view, setView] = useState<View>("intro");
  const [problem, setProblem] = useState<TryOnErrorCode>("load-failed");
  const [progress, setProgress] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [info, setInfo] = useState<TryOnFrameInfo>(NOTHING_SEEN);
  const [comparing, setComparing] = useState(false);
  const [split, setSplit] = useState(0.5);
  const [facing, setFacing] = useState<Facing>("user");
  const [canFlip, setCanFlip] = useState(false);
  const [shot, setShot] = useState<{ url: string; file: File } | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const engineRef = useRef<HairTryOnEngine | null>(null);

  const live = view === "camera" || view === "photo";

  const fail = useCallback((error: unknown) => {
    setProblem(error instanceof TryOnError ? error.code : "load-failed");
    setView("error");
  }, []);

  // The engine lives as long as the modal; "Try again" builds a fresh one
  useEffect(() => {
    const host = hostRef.current;
    const video = videoRef.current;
    if (!host || !video) return;

    const engine = new HairTryOnEngine({
      container: host,
      video,
      label: "Preview of the selected hair shade on you",
      onInfo: setInfo,
      onError: fail,
    });
    engineRef.current = engine;

    // Start downloading the model straight away so the camera opens sooner
    let active = true;
    engine
      .load((fraction) => {
        if (active) setProgress((shown) => (fraction >= 1 || fraction - shown >= 0.02 ? fraction : shown));
      })
      .catch((error) => active && fail(error));

    const observer = new ResizeObserver(() => engine.resize());
    observer.observe(host);

    return () => {
      active = false;
      observer.disconnect();
      engine.destroy();
      engineRef.current = null;
    };
  }, [attempt, fail]);

  useEffect(() => {
    engineRef.current?.setShade(getHairShadeProfile(shade));

    // A shade without measured tones starts from an estimate and switches to
    // tones read from its swatch photo as soon as that has loaded
    let current = true;
    void loadSwatchProfile(shade).then((profile) => {
      if (current && profile) engineRef.current?.setShade(profile);
    });
    return () => {
      current = false;
    };
  }, [shade, attempt]);

  // Fine-tuning sliders for the dye blend, shown only when the page is opened with ?tune
  const [tuneMode] = useState(() => new URLSearchParams(window.location.search).has("tune"));
  const [tuning, setTuning] = useState<TryOnTuning>(DEFAULT_TUNING);
  useEffect(() => {
    engineRef.current?.setTuning(tuning);
  }, [tuning, attempt]);

  useEffect(() => {
    engineRef.current?.setCompare(comparing && live ? split : null);
  }, [comparing, split, live, attempt]);

  // Lock the page behind, close on Escape, and give focus back to the opener afterwards
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = overflow === "hidden" ? "" : overflow;
      opener?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (shot) setShot(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shot, onClose]);

  useEffect(() => {
    if (!shot) return;
    return () => URL.revokeObjectURL(shot.url);
  }, [shot]);

  const startCamera = async (face: Facing = facing) => {
    const engine = engineRef.current;
    if (!engine) return;
    setView("starting");
    setFacing(face);
    setInfo(NOTHING_SEEN);
    try {
      if (!(await engine.startCamera(face))) return;
      setView("camera");
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      setCanFlip(devices.filter((device) => device.kind === "videoinput").length > 1);
    } catch (error) {
      fail(error);
    }
  };

  const openPhoto = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    const engine = engineRef.current;
    if (!file || !engine) return;
    setView("starting");
    setInfo(NOTHING_SEEN);
    try {
      if (!(await engine.showPhoto(file))) return;
      setView("photo");
    } catch (error) {
      fail(error);
    }
  };

  const takePhoto = async () => {
    try {
      const blob = await engineRef.current?.capture();
      if (!blob) return;
      const name = `colourpig-${shade.code.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-try-on.jpg`;
      setShot({ url: URL.createObjectURL(blob), file: new File([blob], name, { type: "image/jpeg" }) });
    } catch (error) {
      fail(error);
    }
  };

  const saveShot = () => {
    if (!shot) return;
    const link = document.createElement("a");
    link.href = shot.url;
    link.download = shot.file.name;
    link.click();
  };

  const canShare =
    !!shot && typeof navigator.canShare === "function" && navigator.canShare({ files: [shot.file] });

  const shareShot = async () => {
    if (!shot) return;
    try {
      await navigator.share({ files: [shot.file], title: `${shade.name} try-on` });
    } catch {
      /* Share sheet dismissed */
    }
  };

  const retry = () => {
    setProgress(0);
    setView("intro");
    setAttempt((n) => n + 1);
  };

  const addToBag = () => {
    store.addToCart({
      id: `${shade.id}-${kit.id}`,
      name:
        kit.id === "starter-system"
          ? `Colourpig Starter System | ${shade.name}`
          : `Colourpig ${kit.name} | ${shade.name}`,
      variant: `Shade ${shade.code} • ${kit.subtitle}`,
      price: kit.price,
      image: shade.cardImage,
      shadeCode: shade.code,
      shadeHex: shade.hex,
    });
    // The bag opens itself; step out of its way
    onClose();
  };

  const moveSplit = (clientX: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (rect) setSplit(Math.min(0.94, Math.max(0.06, (clientX - rect.left) / rect.width)));
  };

  const trapFocus = (event: React.KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const items = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!items?.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const hint = !live
    ? null
    : !info.hairVisible
      ? { icon: ScanFace, text: "We can't see your hair. Move back so all of it is in view." }
      : info.lowLight
        ? { icon: Sun, text: "It's a little dark. Face a window or a light for a truer colour." }
        : null;

  // How many levels lighter the shade is than the wearer's own hair looks on camera.
  // From three levels up, root colour can't get darker hair there (the shade-match guide
  // says the same), and the preview alone would promise more than the product does.
  const levelsLighter =
    live && !isClear && info.hairLevel !== null ? shadeLevel(shade) - info.hairLevel : 0;

  const issue = PROBLEMS[problem];

  return createPortal(
    // data-lenis-prevent: locking body scroll stops Lenis, which then swallows wheel and touch
    // events; this lets the shade list scroll on its own
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="try-on-title"
      tabIndex={-1}
      data-lenis-prevent
      onKeyDown={trapFocus}
      className="fixed inset-0 z-[95] flex items-stretch lg:items-center justify-center lg:p-6 outline-none"
    >
      <div className="absolute inset-0 bg-obsidian/85 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />

      <div className="relative z-10 flex flex-col lg:flex-row w-full lg:max-w-[1120px] h-[100dvh] lg:h-[min(88vh,800px)] bg-white text-obsidian lg:rounded-3xl overflow-hidden shadow-2xl">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close try-on"
          className="absolute top-3 right-3 z-30 w-10 h-10 rounded-full bg-white/90 hover:bg-white text-obsidian shadow-md flex items-center justify-center transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>

        {/* ------------------------------------------------ Stage: the preview */}
        <div ref={stageRef} className="relative flex-1 min-h-0 bg-obsidian overflow-hidden select-none">
          <video ref={videoRef} playsInline muted aria-hidden="true" className="absolute w-px h-px opacity-0 pointer-events-none" />
          {/* The engine adds its canvas here */}
          <div
            ref={hostRef}
            className={`absolute inset-0 transition-opacity duration-300 ${live ? "opacity-100" : "opacity-0"}`}
          />
          <input ref={fileRef} type="file" accept="image/*" onChange={openPhoto} className="hidden" tabIndex={-1} />

          {view === "intro" && (
            <div className="absolute inset-0 flex flex-col items-center justify-end sm:justify-center text-center text-white px-6 pb-10 sm:pb-0">
              <Image
                src={shade.modelImage}
                alt=""
                fill
                sizes="(max-width: 1024px) 100vw, 740px"
                className="object-cover object-top opacity-45"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-obsidian via-obsidian/70 to-obsidian/20" />

              <div className="relative max-w-sm flex flex-col items-center">
                <span className="w-12 h-12 rounded-full bg-white/10 border border-white/25 flex items-center justify-center">
                  <ScanFace className="w-5 h-5" />
                </span>
                <p className="mt-5 font-headline font-bold text-2xl sm:text-[28px] uppercase tracking-wider leading-tight">
                  See {shade.name} on your own hair
                </p>
                <p className="mt-3 text-sm text-platinum">
                  {isClear
                    ? "Clear adds shine without changing your colour. Watch it live on camera, or try it on a photo."
                    : "Watch the colour move with you live on camera, or try it on a photo."}
                </p>

                <div className="mt-6 w-full flex flex-col sm:flex-row gap-2.5">
                  <button
                    type="button"
                    onClick={() => startCamera()}
                    className="sm:flex-1 h-12 shrink-0 rounded-xl bg-white hover:bg-platinum text-obsidian font-mono text-xs font-bold tracking-widest uppercase flex items-center justify-center gap-2 transition-colors cursor-pointer"
                  >
                    <Camera className="w-4 h-4" />
                    Start camera
                  </button>
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    className="sm:flex-1 h-12 shrink-0 rounded-xl border border-white/40 hover:bg-white/10 text-white font-mono text-xs font-bold tracking-widest uppercase flex items-center justify-center gap-2 transition-colors cursor-pointer"
                  >
                    <ImageUp className="w-4 h-4" />
                    Use a photo
                  </button>
                </div>

                <p className="mt-5 flex items-start gap-2 text-left text-[11px] font-mono text-ash">
                  <ShieldCheck className="w-3.5 h-3.5 mt-px shrink-0" />
                  Your camera and photos stay on this device. Nothing is uploaded or stored.
                </p>
              </div>
            </div>
          )}

          {view === "starting" && (
            <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-white px-6">
              <LoaderCircle className="w-8 h-8 animate-spin" />
              <p className="text-xs font-mono font-bold uppercase tracking-wider">
                {progress < 1 ? `Loading try-on ${Math.round(progress * 100)}%` : "Starting"}
              </p>
              {progress < 1 && (
                <div className="w-44 h-1 rounded-full bg-white/15 overflow-hidden">
                  <div className="h-full bg-white rounded-full transition-[width] duration-200" style={{ width: `${progress * 100}%` }} />
                </div>
              )}
            </div>
          )}

          {view === "error" && (
            <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center text-center text-white px-6">
              <span className="w-12 h-12 rounded-full bg-white/10 border border-white/25 flex items-center justify-center">
                <CameraOff className="w-5 h-5" />
              </span>
              <p className="mt-5 font-headline font-bold text-xl uppercase tracking-wider">{issue.title}</p>
              <p className="mt-2.5 max-w-xs text-sm text-platinum">{issue.body}</p>
              <div className="mt-6 flex flex-wrap justify-center gap-2.5">
                <button type="button" onClick={retry} className={`${STAGE_BUTTON} bg-white hover:bg-platinum text-obsidian border-transparent`}>
                  Try again
                </button>
                {issue.offerPhoto && (
                  <button type="button" onClick={() => fileRef.current?.click()} className={STAGE_BUTTON}>
                    <ImageUp className="w-4 h-4" />
                    Use a photo
                  </button>
                )}
              </div>
            </div>
          )}

          {live && (
            <>
              <div className="absolute inset-x-0 bottom-0 h-36 bg-gradient-to-t from-black/60 to-transparent pointer-events-none" />

              <div className="absolute top-3 left-3 right-16 flex flex-col items-start gap-2 pointer-events-none">
                <span className="h-8 px-3 rounded-full bg-black/45 backdrop-blur-md border border-white/20 text-white text-[10px] font-mono font-bold uppercase tracking-wider flex items-center gap-2">
                  <ShadeSwatch shade={shade} size={16} className="w-4 h-4 ring-1 ring-white/40" />
                  {shade.code} {shade.name.replace(/No\.\S+\s*/, "")}
                </span>
                {hint && (
                  <span role="status" className="max-w-[280px] px-3 py-2 rounded-2xl bg-black/55 backdrop-blur-md border border-white/20 text-white text-[11px] leading-snug flex items-start gap-2">
                    <hint.icon className="w-3.5 h-3.5 mt-px shrink-0" />
                    {hint.text}
                  </span>
                )}
              </div>

              {comparing && (
                <>
                  <span className="absolute top-14 left-3 px-2 py-1 rounded-md bg-black/45 text-white text-[10px] font-mono font-bold uppercase tracking-wider pointer-events-none">
                    Before
                  </span>
                  <div
                    className="absolute inset-y-0 w-11 -ml-[22px] flex justify-center cursor-ew-resize touch-none"
                    style={{ left: `${split * 100}%` }}
                    onPointerDown={(event) => {
                      event.currentTarget.setPointerCapture(event.pointerId);
                      moveSplit(event.clientX);
                    }}
                    onPointerMove={(event) => {
                      if (event.currentTarget.hasPointerCapture(event.pointerId)) moveSplit(event.clientX);
                    }}
                  >
                    <span className="w-0.5 h-full bg-white shadow-[0_0_6px_rgba(0,0,0,0.5)]" />
                    <button
                      type="button"
                      role="slider"
                      aria-label="Before and after divider"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(split * 100)}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowLeft") setSplit((s) => Math.max(0.06, s - 0.04));
                        if (event.key === "ArrowRight") setSplit((s) => Math.min(0.94, s + 0.04));
                      }}
                      className="absolute top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white text-obsidian shadow-lg flex items-center justify-center cursor-ew-resize"
                    >
                      <ChevronsLeftRight className="w-4 h-4" />
                    </button>
                  </div>
                </>
              )}

              <div className="absolute inset-x-0 bottom-4 px-3 flex items-center justify-center gap-2.5">
                <button
                  type="button"
                  onClick={() => setComparing((on) => !on)}
                  aria-pressed={comparing}
                  className={`${STAGE_BUTTON} ${comparing ? "!bg-white !text-obsidian" : ""}`}
                >
                  <SquareSplitHorizontal className="w-4 h-4" />
                  <span className="hidden sm:inline">Compare</span>
                </button>

                <button
                  type="button"
                  onClick={takePhoto}
                  aria-label={view === "camera" ? "Take a photo" : "Save this look"}
                  className="w-16 h-16 rounded-full bg-white text-obsidian border-4 border-white/40 bg-clip-padding shadow-xl flex items-center justify-center transition-transform hover:scale-105 active:scale-95 cursor-pointer"
                >
                  {view === "camera" ? <Camera className="w-6 h-6" /> : <Download className="w-6 h-6" />}
                </button>

                {view === "camera" ? (
                  <>
                    {canFlip && (
                      <button
                        type="button"
                        onClick={() => startCamera(facing === "user" ? "environment" : "user")}
                        aria-label="Switch camera"
                        className={`${STAGE_BUTTON} w-11 !px-0`}
                      >
                        <SwitchCamera className="w-4 h-4" />
                      </button>
                    )}
                    <button type="button" onClick={() => fileRef.current?.click()} className={STAGE_BUTTON}>
                      <ImageUp className="w-4 h-4" />
                      <span className="hidden sm:inline">Photo</span>
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      aria-label="Choose another photo"
                      className={`${STAGE_BUTTON} w-11 !px-0`}
                    >
                      <ImageUp className="w-4 h-4" />
                    </button>
                    <button type="button" onClick={() => startCamera()} className={STAGE_BUTTON}>
                      <Camera className="w-4 h-4" />
                      <span className="hidden sm:inline">Camera</span>
                    </button>
                  </>
                )}
              </div>
            </>
          )}

          {shot && (
            <div className="absolute inset-0 z-20 bg-obsidian flex flex-col">
              <div className="relative flex-1 min-h-0">
                {/* A just-captured picture held in memory; next/image can't optimise a blob: URL */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={shot.url} alt={`You wearing ${shade.name}`} className="absolute inset-0 w-full h-full object-contain" />
              </div>
              <div className="shrink-0 px-3 py-4 flex flex-wrap items-center justify-center gap-2.5">
                <button type="button" onClick={() => setShot(null)} className={STAGE_BUTTON}>
                  Back
                </button>
                <button type="button" onClick={saveShot} className={`${STAGE_BUTTON} !bg-white !text-obsidian`}>
                  <Download className="w-4 h-4" />
                  Save photo
                </button>
                {canShare && (
                  <button type="button" onClick={shareShot} className={STAGE_BUTTON}>
                    <Share2 className="w-4 h-4" />
                    Share
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ------------------------------------------------ Panel: shade and bag */}
        <aside className="shrink-0 lg:w-[380px] flex flex-col gap-3 lg:gap-7 bg-white border-t lg:border-t-0 lg:border-l border-ash/25 px-4 pt-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] lg:p-8">
          <header className="flex items-center gap-3 lg:block lg:pr-10">
            <ShadeSwatch shade={shade} size={40} className="lg:hidden w-10 h-10 ring-1 ring-black/10" />
            <div className="min-w-0">
              <p className="hidden lg:block text-[10px] font-mono font-bold uppercase tracking-[0.2em] text-graphite">
                Virtual try-on
              </p>
              <h2
                id="try-on-title"
                className="font-headline font-bold text-base lg:text-2xl uppercase tracking-wider leading-tight truncate lg:whitespace-normal lg:mt-2.5"
              >
                {shade.name}
              </h2>
              <p className="text-[11px] lg:text-xs font-mono text-graphite truncate lg:whitespace-normal lg:mt-2">
                {isClear ? "Shine only. Keeps your own colour." : `${shade.category} · ${shade.undertone}`}
              </p>
            </div>
            <span className="lg:hidden ml-auto shrink-0 text-sm font-montserrat font-semibold">
              {store.formatPrice(kit.price)}
            </span>
          </header>

          {levelsLighter >= 3 && (
            <p role="note" className="-mt-1 lg:-mt-3 px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-[11px] leading-snug text-obsidian">
              About {levelsLighter} levels lighter than your hair. Root colour can&apos;t lighten natural hair that far, so
              expect greys to take this shade while darker hair stays closer to its own colour.
            </p>
          )}

          <div className="min-h-0 lg:overflow-y-auto custom-drawer-scrollbar">
            <p className="hidden lg:block text-[11px] font-mono font-bold uppercase tracking-wider mb-3">Choose a shade</p>
            <div
              role="radiogroup"
              aria-label="Shade"
              className="flex lg:grid lg:grid-cols-4 gap-1.5 lg:gap-x-2 lg:gap-y-4 -mx-4 px-4 lg:mx-0 lg:px-1 py-1.5 overflow-x-auto lg:overflow-visible [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {shades.map((option) => {
                const active = option.id === shade.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={option.name}
                    title={option.name}
                    onClick={() => setShadeId(option.id)}
                    className="shrink-0 w-[54px] lg:w-auto flex flex-col items-center gap-1.5 cursor-pointer group"
                  >
                    <ShadeSwatch
                      shade={option}
                      size={48}
                      className={`w-11 h-11 lg:w-12 lg:h-12 transition-all ${
                        active
                          ? "ring-2 ring-obsidian ring-offset-2"
                          : "ring-1 ring-black/15 group-hover:scale-105"
                      }`}
                    />
                    <span className={`text-[10px] font-mono ${active ? "font-bold text-obsidian" : "text-graphite"}`}>
                      {option.code}
                    </span>
                  </button>
                );
              })}
            </div>

            {tuneMode && (
              <div className="mt-4 p-3 rounded-xl border border-black/10 bg-black/[0.02] space-y-2.5">
                <div className="flex items-center justify-between">
                  <p className="text-[11px] font-mono font-bold uppercase tracking-wider">Tuning</p>
                  <div className="flex gap-3 text-[10px] font-mono underline">
                    <button type="button" className="cursor-pointer" onClick={() => setTuning(DEFAULT_TUNING)}>
                      Reset
                    </button>
                    <button
                      type="button"
                      className="cursor-pointer"
                      onClick={() => void navigator.clipboard?.writeText(JSON.stringify(tuning, null, 2))}
                    >
                      Copy values
                    </button>
                  </div>
                </div>
                {TUNING_SLIDERS.map(({ key, label, min, max, step }) => (
                  <label key={key} className="block">
                    <span className="flex justify-between text-[10px] font-mono text-graphite">
                      <span>{label}</span>
                      <span>{tuning[key]}</span>
                    </span>
                    <input
                      type="range"
                      min={min}
                      max={max}
                      step={step}
                      value={tuning[key]}
                      onChange={(event) => setTuning((current) => ({ ...current, [key]: Number(event.target.value) }))}
                      className="w-full accent-obsidian"
                    />
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="lg:mt-auto space-y-2.5 lg:space-y-3.5">
            <div className="hidden lg:flex items-baseline justify-between gap-3">
              <span className="text-[11px] font-mono uppercase tracking-wider text-graphite">{kit.name}</span>
              <span className="text-xl font-montserrat font-semibold">{store.formatPrice(kit.price)}</span>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={addToBag}
                disabled={!kit.available}
                className="flex-1 h-12 rounded-xl bg-obsidian hover:bg-black text-white font-mono text-xs font-bold tracking-widest uppercase flex items-center justify-center gap-2 shadow-md transition-all active:scale-[0.99] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-obsidian"
              >
                <ShoppingBag className="w-4 h-4" />
                {kit.available ? "Add to bag" : "Sold out"}
              </button>
              {shade.id !== pageShadeId && (
                <Link
                  href={`/product?shade=${shade.id}`}
                  onClick={onClose}
                  className="h-12 px-4 rounded-xl border border-ash/40 hover:bg-black/5 text-obsidian font-mono text-xs font-bold tracking-widest uppercase flex items-center justify-center transition-colors"
                >
                  Details
                </Link>
              )}
            </div>
            <p className="text-[10px] leading-snug font-mono text-graphite">
              A simulation. Your real result depends on your natural colour and how much grey you have.
            </p>
          </div>
        </aside>
      </div>
    </div>,
    document.body
  );
}
