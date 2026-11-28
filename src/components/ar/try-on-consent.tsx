"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Check, X } from "lucide-react";

/**
 * Bump this when the consent wording changes in a way that needs shoppers to
 * agree again; older answers are then ignored.
 */
const CONSENT_KEY = "colourpig:try-on-consent";
const CONSENT_VERSION = "2026-11-28.2";

/** Whether this browser has already agreed to the current try-on consent. */
export function hasTryOnConsent() {
  try {
    return window.localStorage.getItem(CONSENT_KEY) === CONSENT_VERSION;
  } catch {
    return false;
  }
}

function rememberConsent() {
  try {
    window.localStorage.setItem(CONSENT_KEY, CONSENT_VERSION);
  } catch {
    /* Storage blocked (private mode): they'll simply be asked again next time */
  }
}

interface TryOnConsentProps {
  onAgree: () => void;
  onCancel: () => void;
}

const LINK = "underline underline-offset-2 font-semibold text-obsidian hover:text-black";

/**
 * Consent shown before the try-on can use the camera or a photo. Both boxes
 * must be ticked before it can be accepted.
 */
export function TryOnConsent({ onAgree, onCancel }: TryOnConsentProps) {
  const [processing, setProcessing] = useState(false);
  const [adult, setAdult] = useState(false);
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const ready = processing && adult;

  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  const agree = () => {
    if (!ready) return;
    rememberConsent();
    onAgree();
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center p-5 bg-obsidian/55">
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative w-full max-w-[360px] max-h-full overflow-y-auto custom-drawer-scrollbar bg-white text-obsidian rounded-xl shadow-2xl px-5 pt-6 pb-5 outline-none"
      >
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close"
          className="absolute top-2.5 right-2.5 w-8 h-8 rounded-full hover:bg-black/5 flex items-center justify-center cursor-pointer"
        >
          <X className="w-5 h-5" strokeWidth={2.2} />
        </button>

        <h3 id={titleId} className="px-8 text-center font-headline text-[18px] font-bold leading-tight">
          Your privacy, our promise
        </h3>

        <div className="mt-4 space-y-3 text-center text-[12px] leading-[1.45] font-medium">
          <p>To use Virtual Try-On, you must be at least 18 years old.</p>
          <p>
            Colourpig, a brand of Norman Brown Pty Ltd (&ldquo;Colourpig&rdquo;, &ldquo;we&rdquo; or &ldquo;us&rdquo;),
            lets you preview our hair colour shades on yourself with a virtual try-on. If you choose to use your live
            camera or upload a photo, your image is processed on your own device, only to show you the shade. It is
            never uploaded to us or stored.
          </p>
          <p>
            The use of this website is governed by our{" "}
            <Link href="/policies/privacy-policy" target="_blank" className={LINK}>
              Privacy Policy
            </Link>
          </p>
        </div>

        <div className="mt-5 space-y-4">
          <ConsentBox checked={processing} onChange={setProcessing}>
            I consent to the detection of my face and hair and the processing of my image as described in the{" "}
            <Link href="/policies/privacy-policy#virtual-try-on" target="_blank" className={LINK}>
              Virtual Try-On notice
            </Link>
            , including that it is processed on my device and is not stored, shared or used to identify me.
          </ConsentBox>
          <ConsentBox checked={adult} onChange={setAdult}>
            I am 18 or older and agree to the{" "}
            <Link href="/policies/terms-of-service" target="_blank" className={LINK}>
              Terms of Service
            </Link>
            , and understand the try-on shows a simulation, not a guaranteed result.
          </ConsentBox>
        </div>

        <button
          type="button"
          onClick={agree}
          disabled={!ready}
          className="mt-5 w-full h-11 rounded-lg bg-obsidian hover:bg-black text-white text-[13px] font-bold transition-colors cursor-pointer disabled:bg-[#9A9A9A] disabled:cursor-not-allowed"
        >
          I consent
        </button>
      </div>
    </div>
  );
}

function ConsentBox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex gap-3 cursor-pointer text-[12px] leading-[1.45] font-medium">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span
        aria-hidden="true"
        className={`mt-px w-[18px] h-[18px] shrink-0 border-[1.5px] border-obsidian flex items-center justify-center peer-focus-visible:ring-2 peer-focus-visible:ring-obsidian peer-focus-visible:ring-offset-2 ${
          checked ? "bg-obsidian text-white" : "bg-white"
        }`}
      >
        {checked && <Check className="w-3 h-3" strokeWidth={3} />}
      </span>
      <span>{children}</span>
    </label>
  );
}
