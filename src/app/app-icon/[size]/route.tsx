import { ImageResponse } from "next/og";

/** PNG app icons for the web app manifest (192 and 512 px; the 512 also as a maskable icon with a safe margin). */
const SIZES = new Set([192, 512]);

export function GET(_req: Request, { params }: { params: Promise<{ size: string }> }) {
  return params.then(({ size }) => {
    const maskable = size.endsWith("-maskable");
    const px = Number(size.replace("-maskable", ""));
    if (!SIZES.has(px)) return new Response("Not found", { status: 404 });
    const mark = Math.round(px * (maskable ? 0.62 : 0.84));
    return new ImageResponse(
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#141217" }}>
        <svg width={mark} height={mark} viewBox="6 6 52 52">
          <defs>
            <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="8" y1="32" x2="56" y2="32">
              <stop offset="0" stopColor="#8b5cf6" />
              <stop offset="0.5" stopColor="#e879f9" />
              <stop offset="1" stopColor="#fb7185" />
            </linearGradient>
          </defs>
          <path d="M32 32C38 22 52 20 54 32C56 44 40 42 32 32C24 22 8 20 10 32C12 44 26 42 32 32Z" fill="none" stroke="url(#g)" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>,
      { width: px, height: px, headers: { "Cache-Control": "public, max-age=86400, immutable" } },
    );
  });
}
