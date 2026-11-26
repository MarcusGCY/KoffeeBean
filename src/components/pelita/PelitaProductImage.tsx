"use client";

import { useState } from "react";
import { PELITA_ART, type PelitaArtKey } from "@/lib/demo/pelita-art";

/** Image when a safe URL is configured and it loads; the kit SVG otherwise. */
export function productArtMode(imageUrl: string | null | undefined, failed: boolean): "image" | "svg" {
  return imageUrl && !failed ? "image" : "svg";
}

export function PelitaProductImage({
  imageUrl,
  art,
  alt,
  className,
  failed = false,
}: {
  imageUrl?: string | null;
  art: PelitaArtKey;
  alt: string;
  className?: string;
  /** Renders the SVG even when `imageUrl` is set. The img `onError` path sets the same mode. */
  failed?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const mode = productArtMode(imageUrl, failed || broken);
  if (mode === "image") {
    return (
      <img
        src={imageUrl!}
        alt={alt}
        data-product-image=""
        className={className ?? "h-full w-full object-contain"}
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <div
      data-product-art=""
      className={`${className ?? "h-full w-full"} [&>svg]:h-full [&>svg]:w-full`}
      dangerouslySetInnerHTML={{ __html: PELITA_ART[art] }}
    />
  );
}
