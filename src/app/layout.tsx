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

/**
Provides the shared document, theme and viewport shell for Pocket routes.
@param props - Next route content mounted inside the shared document body.
@returns Shared root document.
*/
export default function RootLayout({ children, viewer }: LayoutProps<"/">) {
  return (
    <html lang="en" className="dark">
      <body>
        {children}
        {viewer}
      </body>
    </html>
  );
}
