import "./globals.css";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Pocket",
  description: "A conversation with Codex on your computer.",
  applicationName: "Pocket",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Pocket" },
  icons: { icon: "/icon-192.png", apple: "/apple-touch-icon.png" },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#212121",
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
