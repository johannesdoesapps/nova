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
          <svg width="72" height="72" viewBox="0 0 64 64">
            <defs>
              <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="16" y1="48" x2="48" y2="16">
                <stop offset="0" stopColor="#22d3ee" />
                <stop offset="0.5" stopColor="#3b82f6" />
                <stop offset="1" stopColor="#8b5cf6" />
              </linearGradient>
            </defs>
            <path d="M24 16V9M32 16V9M40 16V9M24 48V55M32 48V55M40 48V55M16 24H9M16 32H9M16 40H9M48 24H55M48 32H55M48 40H55" stroke="#60a5fa" strokeWidth="4" strokeLinecap="round" fill="none" />
            <rect x="16" y="16" width="32" height="32" rx="7" fill="url(#g)" />
            <circle cx="32" cy="32" r="7.5" fill="none" stroke="#ffffff" strokeWidth="4.2" />
            <circle cx="40.5" cy="23.5" r="2.2" fill="#ffffff" />
          </svg>
          <div style={{ fontSize: 34, letterSpacing: 10, fontWeight: 600 }}>ORBIS</div>
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
