"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { DeviceGlyphBadge } from "@/components/ui/glyphs";
import { Modal } from "@/components/ui/modal";
import { DEVICE_TYPE_LABELS } from "@/lib/utils/device";
import { useCountdown } from "@/hooks/use-timing";
import { useIncomingRequests, usePeerActions } from "@/hooks/use-share-go";
import type { IncomingRequestSnapshot } from "@/types/webrtc";

/**
 * The consent gate. Nothing is negotiated — not even an SDP offer — until the
 * user on the other device taps Accept, so an unapproved peer can do nothing
 * at all: it cannot learn the file list and it cannot open a data channel.
 */
export function ConnectionRequestDialog() {
  const requests = useIncomingRequests();
  const { respond } = usePeerActions();
  const request = requests[0] ?? null;

  return (
    <Modal
      open={request !== null}
      onClose={() => {
        if (request) respond(request.requestId, false);
      }}
      title="Connection request"
      description="Only accept if you recognise this device."
      footer={
        request ? (
          <RequestFooter request={request} onRespond={respond} />
        ) : null
      }
    >
      {request ? <RequestBody request={request} /> : null}
    </Modal>
  );
}

function RequestBody({ request }: { request: IncomingRequestSnapshot }) {
  return (
    <div className="flex flex-col items-center gap-3 px-5 py-7 text-center">
      <span className="animate-pulse-ring grid size-16 place-items-center rounded-2xl">
        <DeviceGlyphBadge type={request.deviceType} size="lg" />
      </span>
      <p className="text-base font-medium text-ink">{request.deviceName}</p>
      <p className="max-w-[34ch] text-sm leading-relaxed text-ink-muted">
        {DEVICE_TYPE_LABELS[request.deviceType]} wants to connect and browse the files you
        have chosen to share. Accepting opens a direct, encrypted link between the two
        devices.
      </p>
    </div>
  );
}

function RequestFooter({
  request,
  onRespond,
}: {
  request: IncomingRequestSnapshot;
  onRespond: (requestId: string, accepted: boolean) => void;
}) {
  const remaining = useCountdown(request.expiresAt);

  // The dialog self-dismisses when the server-side deadline passes.
  useEffect(() => {
    if (remaining !== 0) return;
    onRespond(request.requestId, false);
  }, [remaining, request.requestId, onRespond]);

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="secondary"
        size="lg"
        block
        onClick={() => onRespond(request.requestId, false)}
      >
        Reject
      </Button>
      <Button
        variant="primary"
        size="lg"
        block
        data-autofocus
        onClick={() => onRespond(request.requestId, true)}
      >
        Accept
      </Button>
      <p className="sr-only" aria-live="polite">
        {remaining !== null && remaining > 0
          ? `Expires in ${Math.ceil(remaining / 1000)} seconds`
          : "Request expired"}
      </p>
    </div>
  );
}
