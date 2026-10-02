"use client";

import type { FileCategory } from "@/types/files";
import {
  ArchiveIcon,
  AudioIcon,
  DesktopIcon,
  DocumentIcon,
  FileIcon,
  ImageIcon,
  PhoneIcon,
  TabletIcon,
  UnknownDeviceIcon,
  VideoIcon,
} from "@/components/ui/icons";
import type { DeviceType } from "@/types/signaling";

/* ------------------------------------------------------------------ */
/* Devices                                                             */
/* ------------------------------------------------------------------ */

const DEVICE_ICONS = {
  phone: PhoneIcon,
  tablet: TabletIcon,
  desktop: DesktopIcon,
  unknown: UnknownDeviceIcon,
} as const;

export function DeviceGlyph({
  type,
  className = "size-5",
}: {
  type: DeviceType;
  className?: string;
}) {
  const Icon = DEVICE_ICONS[type] ?? UnknownDeviceIcon;
  return <Icon className={className} />;
}

export function DeviceGlyphBadge({
  type,
  size = "md",
}: {
  type: DeviceType;
  size?: "sm" | "md" | "lg";
}) {
  const box = size === "lg" ? "size-14 rounded-2xl" : size === "sm" ? "size-9 rounded-lg" : "size-11 rounded-xl";
  const icon = size === "lg" ? "size-7" : size === "sm" ? "size-4.5" : "size-5.5";

  return (
    <span
      className={`grid shrink-0 place-items-center border border-hairline bg-surface-2 text-ink-muted ${box}`}
    >
      <DeviceGlyph type={type} className={icon} />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

const CATEGORY_ICONS = {
  image: ImageIcon,
  video: VideoIcon,
  audio: AudioIcon,
  document: DocumentIcon,
  archive: ArchiveIcon,
  other: FileIcon,
} as const;

const CATEGORY_TINTS = {
  image: "text-accent bg-accent/10",
  video: "text-[#c084fc] bg-[#c084fc]/10",
  audio: "text-positive bg-positive/10",
  document: "text-caution bg-caution/10",
  archive: "text-ink-muted bg-surface-3",
  other: "text-ink-muted bg-surface-3",
} as const;

export function CategoryIcon({
  category,
  className = "size-5",
}: {
  category: FileCategory;
  className?: string;
}) {
  const Icon = CATEGORY_ICONS[category] ?? FileIcon;
  return <Icon className={className} />;
}

export function CategoryBadge({
  category,
  className = "",
}: {
  category: FileCategory;
  className?: string;
}) {
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-lg ${CATEGORY_TINTS[category]} ${className}`}
    >
      <CategoryIcon category={category} />
    </span>
  );
}
