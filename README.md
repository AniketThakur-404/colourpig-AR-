# ColourPig

A high-performance modern web experience engineered with 3D WebGL visuals, fluid smooth scrolling, spring physics, and timeline motion orchestration.

## 🚀 Built With

- **[Next.js](https://nextjs.org/)** (App Router & React 19)
- **[Tailwind CSS v3.4](https://tailwindcss.com/)** + PostCSS & Autoprefixer
- **[Three.js](https://threejs.org/)** & **[@react-three/fiber](https://r3f.docs.pmnd.rs/)**
- **[@react-three/drei](https://github.com/pmndrs/drei)**
- **[Lenis](https://lenis.darkroom.engineering/)** Smooth Virtual Scrolling
- **[GSAP](https://greensock.com/gsap/)** & ScrollTrigger (synced to Lenis loop)
- **[Framer Motion v14](https://www.framer.com/motion/)** (Spring gestures & Layout transitions)
- **[Shadcn UI](https://ui.shadcn.com/)** Tokens & Radix UI Primitives
- **[TypeScript](https://www.typescriptlang.org/)**

---

## 🛠️ Getting Started

### 1. Install Dependencies
```bash
npm install --legacy-peer-deps
```

### 2. Run the Development Server
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to explore the experience.

### 3. Production Build
```bash
npm run build
npm run start
```

---

## 📁 Project Architecture

```
ColourPig/
├── src/
│   ├── app/
│   │   ├── globals.css              # Tailwind v3 directives, design tokens, Lenis styles
│   │   ├── layout.tsx               # Root layout with SmoothScrollProvider & metadata
│   │   └── page.tsx                 # Main showcase page
│   ├── components/
│   │   ├── canvas/
│   │   │   ├── scene-3d.tsx         # Three.js / R3F interactive 3D WebGL canvas
│   │   │   └── scene-wrapper.tsx    # SSR-safe dynamic loader
│   │   ├── icons/
│   │   │   └── github-icon.tsx      # SVG icon component
│   │   ├── navigation/
│   │   │   ├── navbar.tsx           # Glassmorphic header
│   │   │   └── footer.tsx           # Footer
│   │   ├── providers/
│   │   │   └── smooth-scroll-provider.tsx  # Lenis + GSAP ScrollTrigger ticker integration
│   │   ├── sections/
│   │   │   ├── hero-section.tsx     # Hero banner with embedded 3D scene
│   │   │   ├── gsap-showcase.tsx    # GSAP scroll-triggered stagger animation
│   │   │   └── motion-playground.tsx # Interactive Framer Motion spring playground
│   │   └── ui/
│   │       ├── badge.tsx            # Shadcn Badge
│   │       ├── button.tsx           # Shadcn Button (with glow & glass variants)
│   │       └── card.tsx             # Shadcn Card
│   └── lib/
│       └── utils.ts                 # Shadcn cn() helper (clsx + tailwind-merge)
├── components.json                  # Shadcn configuration
├── tailwind.config.ts               # Tailwind CSS v3 theme tokens & animations
└── postcss.config.mjs               # PostCSS configuration
```

---

## 💇 Virtual hair try-on

Shoppers can see any shade on their own hair, live on camera or on a photo. It opens from the
"Virtual try-on" row and "Try it on" chip on a product page, and from the "Try on" chip on each
collection card. Everything runs in the browser; no picture is uploaded.

| Where | What |
| --- | --- |
| `src/components/ar/` | The try-on window and its on-demand loader |
| `src/lib/ar/hair-try-on-engine.ts` | Camera, hair segmentation, measuring, drawing |
| `src/lib/ar/hair-shaders.ts` | The WebGL passes: mask sharpening, local colours, recolouring |
| `src/lib/ar/tone-curve.ts` | Maps the wearer's light and shadow onto a shade |
| `src/lib/ar/shade-profiles.ts` | Each shade's tones as worn |
| `public/mediapipe/` | MediaPipe's segmentation model and runtime (about 35 MB) |

### Testing on a phone

The camera only works on `localhost` or over HTTPS. To open the dev site on a phone on the same Wi-Fi:

```bash
npm run dev:https
```

Then open `https://<this computer's IP>:3000` on the phone and accept the certificate warning.

### Shade colours

Each shade is painted with seven tones measured from its on-model photo
(`public/images/results/model_shade_*.jpg`), listed in `WORN_TONES` in `shade-profiles.ts`.
A shade added later in Shopify needs no code change: its tones are read from its swatch photo.
Add it to `WORN_TONES` only if you want to pin its tones by hand.

### Upgrading MediaPipe

The files in `public/mediapipe/0.10.17/wasm` are copies of
`node_modules/@mediapipe/tasks-vision/wasm` and must match the installed package version.
Browsers keep everything under `/mediapipe` for a year, so never overwrite a file in place.
After upgrading the package, copy its `wasm` folder into a new folder named after the new
version and update `WASM_PATH` in `hair-try-on-engine.ts`.
