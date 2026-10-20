import type { MetadataRoute } from "next";

/**
Describes Pocket's installed-app identity, start route and existing icon assets.
@returns Next web-app manifest metadata.
*/
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Pocket",
    short_name: "Pocket",
    description: "Chat with Codex on your computer.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#212121",
    theme_color: "#212121",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
