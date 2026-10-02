/**
 * Coarse device classification, used only for the emoji/label in the device
 * list. Pure UA sniffing — no fingerprinting, nothing leaves the device.
 */
import type { DeviceType } from "@/types/signaling";

export function detectDeviceType(): DeviceType {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent;

  // iPadOS 13+ masquerades as "Macintosh"; touch points reveal the tablet.
  const isTouchMac = /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;

  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || isTouchMac) return "tablet";
  if (/Mobi|iPhone|iPod|Android/i.test(ua)) return "phone";
  if (/Macintosh|Mac OS X|Windows|Linux|CrOS|X11/i.test(ua)) return "desktop";
  return "unknown";
}

export const DEVICE_TYPE_LABELS: Record<DeviceType, string> = {
  phone: "Phone",
  tablet: "Tablet",
  desktop: "Desktop",
  unknown: "Device",
};
