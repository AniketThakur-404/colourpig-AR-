"use client";

import { useEffect, useRef, useState } from "react";
import Image from "@/components/ui/image";

/*
 * Product photo that swaps to its video while a mouse hovers over it.
 * - The video isn't loaded until the first hover, so a grid of cards doesn't
 *   download every clip up front.
 * - It fades in only once frames are actually playing (no black flash), and
 *   rewinds when the pointer leaves so the next hover starts from the top.
 * - Touch devices and users who prefer reduced motion just see the photo.
 */
export function HoverVideoImage({
  image,
  video,
  alt,
  sizes,
  className = "",
}: {
  image: string;
  video?: string;
  alt: string;
  sizes?: string;
  className?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [mounted, setMounted] = useState(false);
  const [active, setActive] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (active) {
      v.play().catch(() => {});
    } else {
      v.pause();
      v.currentTime = 0;
      setPlaying(false);
    }
  }, [active, mounted]);

  const start = (e: React.PointerEvent) => {
    if (!video || e.pointerType !== "mouse") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setMounted(true);
    setActive(true);
  };
  const stop = () => setActive(false);

  return (
    <div className="absolute inset-0" onPointerEnter={start} onPointerLeave={stop}>
      <Image
        src={image}
        alt={alt}
        fill
        sizes={sizes}
        className={`object-cover object-center ${className}`}
      />
      {video && mounted && (
        <video
          ref={videoRef}
          src={video}
          muted
          loop
          playsInline
          preload="auto"
          aria-hidden="true"
          onPlaying={() => setPlaying(true)}
          className={`absolute inset-0 w-full h-full object-cover object-center transition-opacity duration-300 ${
            active && playing ? "opacity-100" : "opacity-0"
          }`}
        />
      )}
    </div>
  );
}
