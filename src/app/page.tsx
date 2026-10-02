import { ShareGoApp } from "@/components/share-go-app";

/**
 * The whole experience is a client component: WebRTC, DataChannels and
 * `localStorage` have no server equivalent, so there is nothing useful for a
 * Server Component to render here. The page still exists as a server entry
 * point so metadata, fonts and the provider live in the App Router layout.
 */
export default function Page() {
  return <ShareGoApp />;
}
