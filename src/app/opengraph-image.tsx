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
          <svg width="64" height="64" viewBox="0 0 32 32">
            <rect x="1" y="1" width="30" height="30" rx="9" fill="#f2f1ee" />
            <circle cx="16" cy="16" r="7" fill="none" stroke="#0b0b0d" strokeWidth="2.4" />
            <circle cx="20.95" cy="11.05" r="2.9" fill="#a59cf0" stroke="#f2f1ee" strokeWidth="1.6" />
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
