import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0b0b0d" }}>
        <svg width="132" height="132" viewBox="0 0 32 32">
          <rect x="1" y="1" width="30" height="30" rx="9" fill="#f2f1ee" />
          <path d="M10.5 22.5V10l11 12.5V9.5" fill="none" stroke="#0b0b0d" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="26.5" cy="5.5" r="2.6" fill="#a59cf0" />
        </svg>
      </div>
    ),
    size,
  );
}
