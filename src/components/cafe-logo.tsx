import { Coffee } from "lucide-react";
import { useState } from "react";

const LOGO_CANDIDATES = [
  "/cantilounge-logo.png",
  "/cantiloungelogo.png",
  "/cantiloungelogo.jpg",
  "/cantiloungelogo.svg",
  "/cantiloungelogo.jpeg",
  "/cantiloungelogo.webp",
];

export function CafeLogo({ className = "" }: { className?: string }) {
  const [index, setIndex] = useState(0);
  const src = LOGO_CANDIDATES[index];

  if (!src) {
    return (
      <div className={`grid place-items-center rounded-xl bg-primary text-primary-foreground shadow-glow ${className}`}>
        <Coffee className="size-5" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt="CantiLounge logo"
      className={`object-cover ${className}`}
      onError={() => setIndex((current) => (current + 1 < LOGO_CANDIDATES.length ? current + 1 : current))}
      onLoad={() => setIndex((current) => current)}
    />
  );
}
