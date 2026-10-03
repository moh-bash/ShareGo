import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ShareGoProvider } from "@/components/providers/share-go-provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "ShareGo — share files across your Wi-Fi",
  description:
    "Send photos, videos and documents straight between your own devices over your local network. No uploads, no accounts, no cloud.",
  applicationName: "ShareGo",
  appleWebApp: {
    capable: true,
    title: "ShareGo",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false },
  icons: [
    {
      rel: "icon",
      type: "image/png",
      sizes: "32x32",
      url: "@/assets/logo.png",
    }
  ]
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Pinch-zoom stays available: this is a media preview app.
  maximumScale: 5,
  themeColor: "#070a0f",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <ShareGoProvider>{children}</ShareGoProvider>
      </body>
    </html>
  );
}
