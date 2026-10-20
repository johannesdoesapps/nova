import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0b0b0d" }}>
        <svg width="132" height="132" viewBox="0 0 32 32">
          <rect x="1" y="1" width="30" height="30" rx="9" fill="#f2f1ee" />
          <circle cx="16" cy="16" r="7" fill="none" stroke="#0b0b0d" strokeWidth="2.4" />
          <circle cx="20.95" cy="11.05" r="2.9" fill="#a59cf0" stroke="#f2f1ee" strokeWidth="1.6" />
        </svg>
      </div>
    ),
    size,
  );
}
