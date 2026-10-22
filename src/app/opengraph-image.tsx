import { ImageResponse } from "next/og";

export const alt = "Orbis — an AI coding agent that checks its own work";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Social preview for every public page (generated at build time). */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background: "radial-gradient(900px 500px at 70% -10%, #2a2833, transparent 65%), radial-gradient(700px 500px at 0% 110%, #241f45, transparent 60%), #0b0b0d",
          color: "#f2f1ee",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <svg width="104" height="60" viewBox="6 17 52 30">
            <defs>
              <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="8" y1="32" x2="56" y2="32">
                <stop offset="0" stopColor="#8b5cf6" />
                <stop offset="0.5" stopColor="#e879f9" />
                <stop offset="1" stopColor="#fb7185" />
              </linearGradient>
            </defs>
            <path d="M32 32C38 22 52 20 54 32C56 44 40 42 32 32C24 22 8 20 10 32C12 44 26 42 32 32Z" fill="none" stroke="url(#g)" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div style={{ fontSize: 44, letterSpacing: -0.5, fontWeight: 600 }}>orbis</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: 76, lineHeight: 1.05, letterSpacing: -2, maxWidth: 980 }}>Describe it. Orbis builds it and checks its own work.</div>
          <div style={{ fontSize: 30, color: "#a7a6ad", maxWidth: 960 }}>Websites and fixes, tested and checked in a real browser · Claude and GPT models</div>
        </div>
      </div>
    ),
    size,
  );
}
