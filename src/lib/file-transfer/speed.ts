/**
 * Speed estimation for the transfer panel.
 *
 * A raw "bytes so far / elapsed" average makes the number jitter wildly while a
 * transfer warms up. We instead track a windowed average over the last ~1.5s
 * of samples, which settles quickly but does not jump around.
 */

const WINDOW_MS = 1500;
const SAMPLE_INTERVAL_MS = 250;

interface Sample {
  at: number;
  bytes: number;
}

export class SpeedMeter {
  private samples: Sample[] = [];
  private lastSampleAt: number = 0;
  private lastBytes: number = 0;
  private current: number = 0;

  /** Call as often as you like; it self-throttles to ~4 Hz. */
  update(transferredBytes: number, now: number = performance.now()): number {
    if (this.lastSampleAt === 0) {
      this.lastSampleAt = now;
      this.lastBytes = transferredBytes;
      return this.current;
    }

    const delta = now - this.lastSampleAt;
    if (delta < SAMPLE_INTERVAL_MS) return this.current;

    const instant = ((transferredBytes - this.lastBytes) / delta) * 1000;
    this.samples.push({ at: now, bytes: transferredBytes });
    this.lastSampleAt = now;
    this.lastBytes = transferredBytes;

    // Drop samples that fell out of the window.
    const cutoff = now - WINDOW_MS;
    while (this.samples.length > 2 && this.samples[0].at < cutoff) {
      this.samples.shift();
    }

    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const span = last.at - first.at;
    const spanBytes = last.bytes - first.bytes;

    const windowed = span > 0 && spanBytes >= 0 ? (spanBytes / span) * 1000 : instant;
    // Smooth against the previous value so the UI does not strobe.
    this.current = this.current === 0 ? windowed : this.current * 0.6 + windowed * 0.4;

    return this.current;
  }

  reset(): void {
    this.samples = [];
    this.lastSampleAt = 0;
    this.lastBytes = 0;
    this.current = 0;
  }

  get bytesPerSecond(): number {
    return this.current;
  }
}
