// Renders the Orbis mark (same artwork as src/app/app-icon) into the source images @capacitor/assets expects in
// mobile/assets. Run `node scripts/brand-assets.cjs && npm run assets` after changing the mark.
const sharp = require("sharp");
const path = require("node:path");

const OUT = path.join(__dirname, "..", "assets");
const MARK = `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="8" y1="32" x2="56" y2="32"><stop offset="0" stop-color="#8b5cf6"/><stop offset="0.5" stop-color="#e879f9"/><stop offset="1" stop-color="#fb7185"/></linearGradient></defs><path d="M32 32C38 22 52 20 54 32C56 44 40 42 32 32C24 22 8 20 10 32C12 44 26 42 32 32Z" fill="none" stroke="url(#g)" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`;

function svg(size, markFraction, background) {
  const mark = Math.round(size * markFraction);
  const off = Math.round((size - mark) / 2);
  const bg = background ? `<rect width="${size}" height="${size}" fill="${background}"/>` : "";
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${bg}<svg x="${off}" y="${off}" width="${mark}" height="${mark}" viewBox="6 6 52 52">${MARK}</svg></svg>`);
}

const jobs = [
  ["icon-only.png", svg(1024, 0.84, "#141217")],
  // Android adaptive icons crop the foreground to a circle/squircle: keep the mark inside the 66% safe zone.
  ["icon-foreground.png", svg(1024, 0.6, null)],
  ["icon-background.png", svg(1024, 0, "#141217")],
  ["splash.png", svg(2732, 0.16, "#07070b")],
  ["splash-dark.png", svg(2732, 0.16, "#07070b")],
];
Promise.all(jobs.map(([name, buf]) => sharp(buf).png().toFile(path.join(OUT, name)))).then(() => console.log(`wrote ${jobs.length} images to ${OUT}`));
