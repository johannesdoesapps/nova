import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#141217" }}>
        <svg width="150" height="150" viewBox="6 6 52 52">
          <defs>
            <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="8" y1="32" x2="56" y2="32">
              <stop offset="0" stopColor="#8b5cf6" />
              <stop offset="0.5" stopColor="#e879f9" />
              <stop offset="1" stopColor="#fb7185" />
            </linearGradient>
          </defs>
          <path d="M32 32C38 22 52 20 54 32C56 44 40 42 32 32C24 22 8 20 10 32C12 44 26 42 32 32Z" fill="none" stroke="url(#g)" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    ),
    size,
  );
}
