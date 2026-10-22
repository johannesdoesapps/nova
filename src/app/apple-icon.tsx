import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0a0f1e" }}>
        <svg width="150" height="150" viewBox="0 0 64 64">
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
      </div>
    ),
    size,
  );
}
