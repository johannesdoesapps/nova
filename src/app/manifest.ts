import type { MetadataRoute } from "next";

/** Lets people install Orbis as an app (home screen on phones, its own window on desktops). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Orbis",
    short_name: "Orbis",
    description: "Chat, code and research with the leading AI models in one place.",
    start_url: "/home",
    scope: "/",
    display: "standalone",
    background_color: "#07070b",
    theme_color: "#07070b",
    icons: [
      { src: "/app-icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/app-icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/app-icon/512-maskable", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "New chat", url: "/chat?new" },
      { name: "Code", url: "/code" },
    ],
  };
}
