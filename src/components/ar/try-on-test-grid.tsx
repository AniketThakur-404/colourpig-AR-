"use client";

/**
 * Test grid for the hair try-on (development only, at /try-on-test). Renders every shade
 * shown in the try-on on the same fixed photos, so changes are compared like for like
 * instead of judged on a live camera. Under each picture, the greyscale check: inside the
 * recoloured hair, how far overall brightness moved, and whether the strand contrast
 * (texture) survived.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { canTryOnShade } from "./hair-try-on";
import { useCatalog } from "@/context/catalog-context";
import { HairTryOnEngine } from "@/lib/ar/hair-try-on-engine";
import { getHairShadeProfile, loadSwatchProfile } from "@/lib/ar/shade-profiles";
import { DEFAULT_TUNING, TUNING_SLIDERS, type TryOnTuning } from "@/lib/ar/tuning";

const PHOTOS = [
  { id: "dark-warm", label: "Dark hair, warm light", src: "/images/results/model_shade_2.jpg" },
  { id: "dark-daylight", label: "Dark hair, daylight", src: "/images/model-brunette.jpg" },
  { id: "greys", label: "Hair with greys", src: "/images/results/model_before_gray_roots.jpg" },
];

/** Time for a shade to fade in fully after it is set */
const SETTLE_MS = 1500;

interface Check {
  /** Mean brightness change inside the recoloured hair, out of 255 */
  shift: number;
  /** Strand contrast after ÷ before (1 = texture unchanged; below 1 = flattened) */
  contrast: number;
  /** Brightness changes that aren't the overall shift, out of 255 (0 = texture unchanged) */
  textureError: number;
}

interface Cell {
  url: string;
  check?: Check;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pixelsOf(blob: Blob, width: number): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob);
  const height = Math.round((bitmap.height * width) / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return ctx.getImageData(0, 0, width, height);
}

/** The greyscale check: compares brightness where the try-on changed the picture. */
async function greyscaleCheck(original: Blob, recoloured: Blob): Promise<Check | undefined> {
  const [before, after] = await Promise.all([pixelsOf(original, 400), pixelsOf(recoloured, 400)]);
  const a = before.data;
  const b = after.data;
  const yBefore: number[] = [];
  const yAfter: number[] = [];
  for (let i = 0; i < a.length; i += 4) {
    const changed = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    // JPEG noise stays under this; anything above is the try-on
    if (changed <= 4) continue;
    yBefore.push(a[i] * 0.299 + a[i + 1] * 0.587 + a[i + 2] * 0.114);
    yAfter.push(b[i] * 0.299 + b[i + 1] * 0.587 + b[i + 2] * 0.114);
  }
  const n = yBefore.length;
  if (n < 100) return undefined;
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const meanBefore = mean(yBefore);
  const meanAfter = mean(yAfter);
  let varBefore = 0;
  let varAfter = 0;
  let error = 0;
  for (let i = 0; i < n; i++) {
    varBefore += (yBefore[i] - meanBefore) ** 2;
    varAfter += (yAfter[i] - meanAfter) ** 2;
    error += (yAfter[i] - meanAfter - (yBefore[i] - meanBefore)) ** 2;
  }
  return {
    shift: meanAfter - meanBefore,
    contrast: Math.sqrt(varAfter / Math.max(varBefore, 1e-6)),
    textureError: Math.sqrt(error / n),
  };
}

export function TryOnTestGrid() {
  const { shades: allShades } = useCatalog();
  const shades = allShades.filter((s) => canTryOnShade(s.id));

  const hostRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const engineRef = useRef<HairTryOnEngine | null>(null);
  const runRef = useRef(0);

  const [tuning, setTuning] = useState<TryOnTuning>(DEFAULT_TUNING);
  const [cells, setCells] = useState<Record<string, Cell>>({});
  const [status, setStatus] = useState("Loading the try-on…");
  const [grey, setGrey] = useState(false);

  // Bumped each time an engine is made (development mode makes and drops one first)
  const [engineId, setEngineId] = useState(0);
  useEffect(() => {
    const host = hostRef.current;
    const video = videoRef.current;
    if (!host || !video) return;
    const engine = new HairTryOnEngine({ container: host, video, onError: (e) => setStatus(`Error: ${e.message}`) });
    engineRef.current = engine;
    setEngineId((id) => id + 1);
    return () => {
      runRef.current++; // stops a render in progress
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  const render = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    const run = ++runRef.current;
    const current = () => run === runRef.current;
    setCells({});
    try {
      await engine.load();
      engine.setTuning(tuning);
      for (const photo of PHOTOS) {
        setStatus(`Rendering ${photo.label}…`);
        const file = await (await fetch(photo.src)).blob();
        if (!(await engine.showPhoto(file)) || !current()) return;
        engine.setShade(null);
        await wait(300);
        const original = await engine.capture();
        if (!current()) return;
        setCells((all) => ({ ...all, [`${photo.id}/original`]: { url: URL.createObjectURL(original) } }));

        for (const shade of shades) {
          engine.setShade((await loadSwatchProfile(shade)) ?? getHairShadeProfile(shade));
          await wait(SETTLE_MS);
          if (!current()) return;
          const recoloured = await engine.capture();
          const check = await greyscaleCheck(original, recoloured);
          if (!current()) return;
          setCells((all) => ({ ...all, [`${photo.id}/${shade.id}`]: { url: URL.createObjectURL(recoloured), check } }));
        }
      }
      setStatus("Done.");
    } catch (error) {
      if (current()) setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [shades, tuning]);

  // Render once for each new engine; afterwards, on request
  const rendered = useRef(0);
  useEffect(() => {
    if (engineId === 0 || rendered.current === engineId || shades.length === 0) return;
    rendered.current = engineId;
    void render();
  }, [engineId, render, shades.length]);

  const rows = [{ id: "original", name: "Original" }, ...shades.map((s) => ({ id: s.id, name: s.name }))];

  return (
    <main className="min-h-screen bg-white text-obsidian p-4 sm:p-6 font-mono text-xs">
      <h1 className="text-base font-bold uppercase tracking-wider">Try-on test grid</h1>
      <p className="mt-1 text-graphite">
        Every shade on the same photos. Under each: brightness shift, contrast (after ÷ before; 1.00 = texture kept,
        lower = flattened) and texture error (0 = unchanged), measured inside the recoloured hair.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-3">
        {TUNING_SLIDERS.map(({ key, label, min, max, step }) => (
          <label key={key} className="w-44">
            <span className="flex justify-between text-graphite">
              <span>{label}</span>
              <span>{tuning[key]}</span>
            </span>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={tuning[key]}
              onChange={(event) => setTuning((t) => ({ ...t, [key]: Number(event.target.value) }))}
              className="w-full accent-obsidian"
            />
          </label>
        ))}
        <button type="button" onClick={() => void render()} className="h-9 px-4 rounded-lg bg-obsidian text-white font-bold uppercase cursor-pointer">
          Render
        </button>
        <button type="button" onClick={() => setTuning(DEFAULT_TUNING)} className="h-9 px-3 underline cursor-pointer">
          Reset
        </button>
        <label className="h-9 flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={grey} onChange={(event) => setGrey(event.target.checked)} />
          Greyscale
        </label>
        <span data-testid="status" className="h-9 flex items-center text-graphite">
          {status}
        </span>
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="border-separate border-spacing-2">
          <thead>
            <tr>
              <th />
              {PHOTOS.map((photo) => (
                <th key={photo.id} className="text-left font-bold uppercase">
                  {photo.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <th className="text-left align-top font-bold w-28">{row.name}</th>
                {PHOTOS.map((photo) => {
                  const cell = cells[`${photo.id}/${row.id}`];
                  const check = cell?.check;
                  return (
                    <td key={photo.id} className="align-top">
                      <div className="w-56 aspect-[3/4] bg-black/5 rounded overflow-hidden">
                        {cell && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={cell.url}
                            alt={`${row.name} on ${photo.label}`}
                            className="w-full h-full object-cover"
                            style={grey ? { filter: "grayscale(1)" } : undefined}
                          />
                        )}
                      </div>
                      {check && (
                        <p className={check.contrast < 0.95 || check.textureError > 6 ? "text-red-600" : "text-graphite"}>
                          shift {check.shift >= 0 ? "+" : ""}
                          {check.shift.toFixed(1)} · contrast {check.contrast.toFixed(2)} · texture{" "}
                          {check.textureError.toFixed(1)}
                        </p>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* The engine draws here; it only needs to exist, the grid shows its captures */}
      <div aria-hidden="true" className="fixed -left-[10000px] top-0 w-[480px] h-[640px]">
        <div ref={hostRef} className="w-full h-full" />
        <video ref={videoRef} playsInline muted className="hidden" />
      </div>
    </main>
  );
}
