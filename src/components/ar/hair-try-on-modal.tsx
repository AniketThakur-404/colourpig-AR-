"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowLeftRight,
  Camera,
  CameraOff,
  ChevronLeft,
  ChevronRight,
  ChevronsLeftRight,
  Download,
  ImageUp,
  Lightbulb,
  Sun,
  LoaderCircle,
  ScanFace,
  Share2,
  ShieldCheck,
  ShoppingBag,
  SquareSplitHorizontal,
  SwitchCamera,
  X,
} from "lucide-react";
import Image from "@/components/ui/image";
import { SnoutIcon } from "@/components/brand/logo";
import { findShade } from "@/data/catalog";
import { swatchThumbnail } from "@/data/shades";
import { canTryOnShade } from "./hair-try-on";
import { TryOnConsent, hasTryOnConsent } from "./try-on-consent";
import { useCatalog } from "@/context/catalog-context";
import { useStore } from "@/context/store-context";
import { HairTryOnEngine, TryOnError, TryOnErrorCode, TryOnFrameInfo } from "@/lib/ar/hair-try-on-engine";
import { getHairShadeProfile, loadSwatchProfile } from "@/lib/ar/shade-profiles";
import { DEFAULT_TUNING, TUNING_SLIDERS, type TryOnTuning } from "@/lib/ar/tuning";

export interface HairTryOnModalProps {
  /** Shade to start on, e.g. "shade-4" */
  initialShadeId: string;
  /** Shade of the product page underneath, if any (no longer used by the layout) */
  pageShadeId?: string;
  onClose: () => void;
}

type View = "intro" | "starting" | "camera" | "photo" | "error";
type Facing = "user" | "environment";
type Tab = "shades" | "compare";
type Source = "camera" | "photo";

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

/** Round icon button floating on the picture */
const ROUND_BUTTON =
  "w-10 h-10 shrink-0 rounded-full bg-white/95 hover:bg-white text-obsidian shadow-md flex items-center justify-center transition-colors cursor-pointer";

/** "No.4 Medium Brown" becomes "Medium Brown" */
const shortName = (name: string) => name.replace(/No\.\S+\s*/, "");

const NOTHING_SEEN: TryOnFrameInfo = { hairVisible: true, lowLight: false, hairLevel: null };

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function HairTryOnModal({ initialShadeId, onClose }: HairTryOnModalProps) {
  const store = useStore();
  const { shades: allShades } = useCatalog();
  // Shades can be left out of the try-on (see canTryOnShade)
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
  const [tab, setTab] = useState<Tab>("shades");
  // Set while the consent card is open: "open" when it greets them as the try-on opens,
  // otherwise what to start once they agree
  const [asking, setAsking] = useState<Source | "open" | null>(() => (hasTryOnConsent() ? null : "open"));
  const [lightTip, setLightTip] = useState(false);
  // Screen light: the screen glows white around the picture to light the shopper's face in a
  // dark room, so the camera sees their hair. It only changes the screen, never the try-on itself.
  const [screenLight, setScreenLight] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const shadeRowRef = useRef<HTMLDivElement>(null);
  // Which ends of the shade row have more shades hidden past them
  const [more, setMore] = useState({ left: false, right: false });
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
      if (asking === "open") onClose();
      else if (asking) setAsking(null);
      else if (shot) setShot(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [asking, shot, onClose]);

  // A lighting tip for the first few seconds of each camera session
  useEffect(() => {
    if (!lightTip) return;
    const timer = window.setTimeout(() => setLightTip(false), 4500);
    return () => window.clearTimeout(timer);
  }, [lightTip]);

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
      setLightTip(true);
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

  const checkShadeRow = useCallback(() => {
    const row = shadeRowRef.current;
    if (!row) return;
    const left = row.scrollLeft > 4;
    const right = row.scrollLeft + row.clientWidth < row.scrollWidth - 4;
    setMore((now) => (now.left === left && now.right === right ? now : { left, right }));
  }, []);

  // The observer reports straight away, then again whenever the row changes size
  useEffect(() => {
    const row = shadeRowRef.current;
    if (!row) return;
    const observer = new ResizeObserver(checkShadeRow);
    observer.observe(row);
    return () => observer.disconnect();
  }, [tab, shades.length, checkShadeRow]);

  const slideShades = (direction: 1 | -1) => {
    const row = shadeRowRef.current;
    row?.scrollBy({ left: direction * row.clientWidth * 0.7, behavior: "smooth" });
  };

  /** Camera or photo, but only once they've agreed to the try-on consent */
  const begin = (source: Source) => {
    if (!hasTryOnConsent()) {
      setAsking(source);
      return;
    }
    if (source === "camera") void startCamera();
    else fileRef.current?.click();
  };

  // Saying no to the greeting closes the try-on, as there's nothing it can do without consent
  const cancelConsent = () => {
    if (asking === "open") onClose();
    else setAsking(null);
  };

  // Runs inside the click on "I consent", so the file picker is still allowed to open
  const consented = () => {
    const source = asking;
    setAsking(null);
    if (source === "camera") void startCamera();
    else if (source === "photo") fileRef.current?.click();
  };

  const backToStart = () => {
    engineRef.current?.stopSource();
    setLightTip(false);
    setComparing(false);
    setTab("shades");
    setView("intro");
  };

  const openTab = (next: Tab) => {
    setTab(next);
    // The compare tab shows the split straight away, like flipping a switch
    setComparing(next === "compare");
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
    const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
      (item) => !item.closest("[inert]")
    );
    if (!items.length) return;
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

  const glowing = screenLight && view === "camera";

  const hint: { icon: typeof Sun; text: string; offerLight?: boolean } | null = !live
    ? null
    : !info.hairVisible
      ? { icon: ScanFace, text: "We can't see your hair. Move back so all of it is in view." }
      : info.lowLight && view === "camera" && !glowing
        ? { icon: Lightbulb, text: "It's too dark to see your shade clearly.", offerLight: true }
        : info.lowLight && !glowing
          ? { icon: Lightbulb, text: "It's a little dark. A brighter photo will show the shade better." }
          : lightTip
            ? { icon: Lightbulb, text: "For the truest colour, face a window or a soft, even light." }
            : null;

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
      className="fixed inset-0 z-[95] flex items-stretch justify-center outline-none"
    >
      <div
        className={`absolute inset-0 transition-colors duration-300 ${glowing ? "bg-white" : "bg-obsidian/85 backdrop-blur-sm"}`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* A tall, phone-shaped frame: the picture on top, a sheet of shades underneath */}
      <div className="relative z-10 flex flex-col w-full sm:max-w-[420px] h-[100dvh] bg-white text-obsidian overflow-hidden shadow-2xl">
        <div inert={!!asking} className="flex flex-col flex-1 min-h-0">
          {/* ------------------------------------------------ Stage: the preview */}
          <div ref={stageRef} className="relative flex-1 min-h-0 bg-obsidian overflow-hidden select-none">
            <video ref={videoRef} playsInline muted aria-hidden="true" className="absolute w-px h-px opacity-0 pointer-events-none" />
            {/* The engine adds its canvas here */}
            <div
              ref={hostRef}
              className={`absolute inset-0 transition-opacity duration-300 ${live ? "opacity-100" : "opacity-0"}`}
            />
            {glowing && (
              <div
                aria-hidden="true"
                className="absolute inset-0 z-[5] pointer-events-none"
                style={{ boxShadow: "inset 0 0 0 16px #fff, inset 0 0 80px 36px rgba(255,255,255,0.85)" }}
              />
            )}
            <input ref={fileRef} type="file" accept="image/*" onChange={openPhoto} className="hidden" tabIndex={-1} />

            {view === "intro" && (
              <div className="absolute inset-0 flex flex-col items-center justify-end text-center text-white px-6 pt-16 pb-8 overflow-hidden">
                <Image
                  src={shade.modelImage}
                  alt=""
                  fill
                  sizes="(max-width: 640px) 100vw, 500px"
                  className="object-cover object-top opacity-50"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-obsidian via-obsidian/60 to-obsidian/10" />

                <div className="relative max-w-sm flex flex-col items-center">
                  <p className="text-[13px] leading-snug text-platinum">
                    {isClear
                      ? "Clear adds shine without changing your colour. Watch it live on camera, or try it on a photo."
                      : "Watch the colour move with you live on camera, or try it on a photo."}
                  </p>

                  <div className="mt-5 w-full flex flex-col gap-2">
                    <button
                      type="button"
                      onClick={() => begin("camera")}
                      className="h-11 shrink-0 rounded-full bg-white hover:bg-platinum text-obsidian font-mono text-[11px] font-bold tracking-widest uppercase flex items-center justify-center gap-2 transition-colors cursor-pointer"
                    >
                      <Camera className="w-4 h-4" />
                      Start live camera
                    </button>
                    <button
                      type="button"
                      onClick={() => begin("photo")}
                      className="h-11 shrink-0 rounded-full border border-white/50 hover:bg-white/10 text-white font-mono text-[11px] font-bold tracking-widest uppercase flex items-center justify-center gap-2 transition-colors cursor-pointer"
                    >
                      <ImageUp className="w-4 h-4" />
                      Upload a photo
                    </button>
                  </div>

                  <p className="mt-4 flex items-start gap-1.5 text-left text-[10px] font-mono text-ash">
                    <ShieldCheck className="w-3 h-3 mt-px shrink-0" />
                    Processed on your device. Nothing is uploaded or stored.
                  </p>
                </div>
              </div>
            )}

            {view === "starting" && (
              <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-white px-6">
                <SnoutIcon className="w-10 h-10 animate-pulse" />
                <p className="text-xs font-mono font-bold uppercase tracking-wider">
                  {progress < 1 ? `Loading try-on ${Math.round(progress * 100)}%` : "Starting"}
                </p>
                {progress < 1 ? (
                  <div className="w-44 h-1 rounded-full bg-white/15 overflow-hidden">
                    <div className="h-full bg-white rounded-full transition-[width] duration-200" style={{ width: `${progress * 100}%` }} />
                  </div>
                ) : (
                  <LoaderCircle className="w-5 h-5 animate-spin text-ash" />
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
                    <button type="button" onClick={() => begin("photo")} className={STAGE_BUTTON}>
                      <ImageUp className="w-4 h-4" />
                      Use a photo
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Top bar: always there, so the try-on can be left from any step */}
            <div className="absolute top-0 inset-x-0 z-10 p-3 sm:p-4 flex items-start justify-between gap-2 pointer-events-none">
              <div className="flex items-center gap-2 pointer-events-auto">
                {live ? (
                  <div className="flex flex-col items-start gap-3">
                    <button type="button" onClick={backToStart} aria-label="Back to start" title="Back to start" className={ROUND_BUTTON}>
                      <ArrowLeft className="w-[18px] h-[18px]" />
                    </button>
                    {!comparing && (
                      <button
                        type="button"
                        onClick={() => (view === "camera" ? fileRef.current?.click() : startCamera())}
                        className="-ml-3 sm:-ml-4 h-10 pl-3 pr-4 rounded-r-full bg-white/95 hover:bg-white text-obsidian shadow-md font-mono text-[10px] font-bold uppercase tracking-wider flex items-center gap-2 cursor-pointer"
                      >
                        <ArrowLeftRight className="w-4 h-4" />
                        {view === "camera" ? "Photo" : "Camera"}
                      </button>
                    )}
                  </div>
                ) : (
                  <span className="h-8 pl-1.5 pr-3 rounded-full bg-white/95 text-obsidian shadow-md flex items-center gap-1.5 text-[9px] font-mono font-bold uppercase tracking-[0.16em]">
                    <SnoutIcon className="w-4 h-4" />
                    Virtual try-on
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 pointer-events-auto">
                {view === "camera" && (
                  <button
                    type="button"
                    onClick={() => setScreenLight((on) => !on)}
                    aria-pressed={screenLight}
                    aria-label="Screen light"
                    title={screenLight ? "Turn off screen light" : "Screen light: brighten your face in a dark room"}
                    className={`${ROUND_BUTTON} ${screenLight ? "!bg-pantone-yellow" : ""}`}
                  >
                    <Sun className="w-[18px] h-[18px]" />
                  </button>
                )}
                {view === "camera" && canFlip && (
                  <button
                    type="button"
                    onClick={() => startCamera(facing === "user" ? "environment" : "user")}
                    aria-label="Switch camera"
                    className={ROUND_BUTTON}
                  >
                    <SwitchCamera className="w-[18px] h-[18px]" />
                  </button>
                )}
                {live && (
                  <button
                    type="button"
                    onClick={addToBag}
                    disabled={!kit.available}
                    aria-label={kit.available ? `Add ${shade.name} to bag, ${store.formatPrice(kit.price)}` : "Sold out"}
                    title={kit.available ? `Add to bag · ${store.formatPrice(kit.price)}` : "Sold out"}
                    className={`${ROUND_BUTTON} disabled:opacity-50`}
                  >
                    <ShoppingBag className="w-[18px] h-[18px]" />
                  </button>
                )}
                {live && (
                  <button
                    type="button"
                    onClick={takePhoto}
                    aria-label={view === "camera" ? "Take a photo" : "Save this look"}
                    title={view === "camera" ? "Take a photo" : "Save this look"}
                    className={ROUND_BUTTON}
                  >
                    {view === "camera" ? <Camera className="w-[18px] h-[18px]" /> : <Download className="w-[18px] h-[18px]" />}
                  </button>
                )}
                <button type="button" onClick={onClose} aria-label="Close try-on" className={ROUND_BUTTON}>
                  <X className="w-[18px] h-[18px]" />
                </button>
              </div>
            </div>

            {live && (
              <>
                {hint && (
                  <div className="absolute inset-x-0 top-[40%] z-10 flex justify-center px-6 pointer-events-none">
                    <div className="max-w-[320px] px-4 py-3 rounded-2xl bg-obsidian/75 backdrop-blur-md text-white text-[12px] leading-snug font-medium">
                      <p role="status" className="flex items-center gap-2.5">
                        <hint.icon className="w-5 h-5 shrink-0 text-pantone-yellow" strokeWidth={1.5} />
                        {hint.text}
                      </p>
                      {hint.offerLight && (
                        <button
                          type="button"
                          onClick={() => setScreenLight(true)}
                          className="pointer-events-auto mt-2.5 w-full h-9 rounded-full bg-white hover:bg-platinum text-obsidian font-mono text-[10px] font-bold uppercase tracking-widest flex items-center justify-center gap-2 cursor-pointer"
                        >
                          <Sun className="w-3.5 h-3.5" />
                          Turn on screen light
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {comparing && (
                  <>
                    <span className="absolute bottom-10 left-3 z-10 px-2.5 py-1 rounded-full bg-black/55 text-white text-[10px] font-mono font-bold uppercase tracking-wider pointer-events-none">
                      Before
                    </span>
                    <span className="absolute bottom-10 right-3 z-10 px-2.5 py-1 rounded-full bg-white text-obsidian text-[10px] font-mono font-bold uppercase tracking-wider pointer-events-none">
                      After
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

              </>
            )}

            {shot && (
              <div className="absolute inset-0 z-20 bg-obsidian flex flex-col">
                <div className="relative flex-1 min-h-0">
                  {/* A just-captured picture held in memory; next/image can't optimise a blob: URL */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={shot.url} alt={`You wearing ${shade.name}`} className="absolute inset-0 w-full h-full object-contain" />
                </div>
                <div className="shrink-0 px-3 pt-4 pb-9 flex flex-wrap items-center justify-center gap-2.5">
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

          {/* ------------------------------------------------ Sheet: shades, compare and bag */}
          <div className="relative z-10 shrink-0 bg-white flex flex-col">
            <h2 id="try-on-title" className="sr-only">
              Virtual try-on: {shade.name}
            </h2>

            {tab === "shades" ? (
              <div className="relative">
                <div
                  ref={shadeRowRef}
                  role="radiogroup"
                  aria-label="Shade"
                  onScroll={checkShadeRow}
                  className="flex gap-2 px-3 pt-2.5 pb-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
                        className="shrink-0 w-[64px] pt-1 flex flex-col items-center gap-1.5 cursor-pointer group"
                      >
                        <span
                          className={`relative block w-11 h-11 rounded-full transition-all ${
                            active ? "ring-2 ring-obsidian ring-offset-2" : "ring-1 ring-black/10 group-hover:-translate-y-0.5"
                          }`}
                          style={{ backgroundColor: option.hex }}
                        >
                          {/* The bundled clean swatch circle (as the site's round swatches use): it fills its
                              frame edge to edge, so it fits the tile exactly with no zoom or offset to go wrong */}
                          <span className="absolute inset-0 rounded-full overflow-hidden isolate [-webkit-mask-image:-webkit-radial-gradient(white,black)]">
                            <Image src={swatchThumbnail(option)} alt="" fill sizes="88px" className="object-cover" />
                          </span>
                        </span>
                        <span
                          className={`w-full line-clamp-2 text-center font-mono text-[9px] leading-tight ${
                            active ? "font-bold text-obsidian" : "font-medium text-steel"
                          }`}
                        >
                          {option.code} {shortName(option.name)}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {/* Faded edges with an arrow, only where more shades are hidden */}
                {(["left", "right"] as const).map((side) => (
                  <div
                    key={side}
                    className={`absolute inset-y-0 ${side === "left" ? "left-0 bg-gradient-to-r" : "right-0 bg-gradient-to-l"} w-12 from-white via-white/80 to-white/0 flex items-center ${
                      side === "left" ? "justify-start pl-1" : "justify-end pr-1"
                    } transition-opacity duration-200 ${more[side] ? "opacity-100" : "opacity-0 pointer-events-none"}`}
                  >
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-hidden="true"
                      onClick={() => slideShades(side === "left" ? -1 : 1)}
                      className="-mt-5 w-7 h-7 rounded-full bg-white/90 text-obsidian shadow-md flex items-center justify-center cursor-pointer hover:bg-white"
                    >
                      {side === "left" ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-3 pt-2.5 pb-2 flex justify-center">
                <button
                  type="button"
                  onClick={() => setComparing((on) => !on)}
                  aria-pressed={comparing}
                  disabled={!live}
                  className={`w-[88px] h-[74px] rounded-xl flex flex-col items-center justify-center gap-2 text-[10px] font-mono font-bold uppercase tracking-wider transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                    comparing ? "bg-obsidian text-white" : "bg-platinum/40 hover:bg-platinum/70 text-obsidian"
                  }`}
                >
                  <SquareSplitHorizontal className="w-6 h-6" strokeWidth={1.4} />
                  Before / after
                </button>
              </div>
            )}

            {tuneMode && (
              <div className="mx-4 mt-2 p-3 max-h-48 overflow-y-auto rounded-xl border border-black/10 bg-black/[0.02] space-y-2.5">
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

            {/* Tabs */}
            <div className="bg-[#F3F4F4] border-t border-platinum px-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
              <div role="tablist" aria-label="Try-on tools" className="relative mx-auto max-w-[220px] grid grid-cols-2">
                <span
                  aria-hidden="true"
                  className={`absolute inset-y-0 left-0 w-1/2 rounded-md bg-obsidian transition-transform duration-300 ${
                    tab === "compare" ? "translate-x-full" : ""
                  }`}
                />
                {(["shades", "compare"] as const).map((name) => (
                  <button
                    key={name}
                    type="button"
                    role="tab"
                    aria-selected={tab === name}
                    disabled={name === "compare" && !live}
                    onClick={() => openTab(name)}
                    className={`relative h-8 rounded-md font-mono text-[10px] font-bold uppercase tracking-widest transition-colors cursor-pointer disabled:cursor-not-allowed disabled:text-ash ${
                      tab === name ? "text-white" : "text-obsidian"
                    }`}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {asking && <TryOnConsent onAgree={consented} onCancel={cancelConsent} />}
      </div>
    </div>,
    document.body
  );
}
