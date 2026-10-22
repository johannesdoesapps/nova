// next/font only works inside the Next.js compiler; in tests every font is a plain class name.
const font = () => ({ className: "font", style: { fontFamily: "sans-serif" }, variable: "--font" });
export const Outfit = font;
export const Instrument_Serif = font;
