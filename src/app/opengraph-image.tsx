import { ImageResponse } from "next/og";

export const alt = "NOVA — AI assistant and agent workspace";
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
            <path d="M10.5 22.5V10l11 12.5V9.5" fill="none" stroke="#0b0b0d" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="26.5" cy="5.5" r="2.6" fill="#a59cf0" />
          </svg>
          <div style={{ fontSize: 34, letterSpacing: 10, fontWeight: 600 }}>NOVA</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: 76, lineHeight: 1.05, letterSpacing: -2, maxWidth: 980 }}>One AI workspace. Agents that help you get work done.</div>
          <div style={{ fontSize: 30, color: "#a7a6ad", maxWidth: 960 }}>Claude and GPT models · custom agents · model comparison · planning · security checks</div>
        </div>
      </div>
    ),
    size,
  );
}
