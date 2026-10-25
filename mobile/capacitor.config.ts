import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Orbis for iOS and Android. The app is a native shell around the live site (https://tryorbis.app): Orbis needs its
 * server for sign-in, AI requests and billing checks, so there is no offline copy of the web app inside the binary.
 * When the site can't be reached the shell shows `www/error.html` (a local page with a Retry button).
 * See docs/MOBILE_APPS.md for the full design and release steps.
 */
const SITE = process.env.ORBIS_APP_URL ?? "https://tryorbis.app";

const config: CapacitorConfig = {
  appId: "app.tryorbis.orbis",
  appName: "Orbis",
  webDir: "www",
  backgroundColor: "#07070b",
  appendUserAgent: "OrbisApp/1.0",
  server: {
    url: SITE,
    errorPath: "error.html",
    // Sign-in with GitHub runs inside the app (Supabase → GitHub → back to tryorbis.app), so its PKCE verifier stays
    // in the app's cookie jar. Google refuses embedded web views, so Google sign-in uses the in-app browser instead
    // (see src/lib/native/bridge.ts). Every other site opens outside the app.
    allowNavigation: ["vbsdxadumiogbdwgvrir.supabase.co", "github.com"],
    cleartext: false,
  },
  ios: {
    contentInset: "never",
    limitsNavigationsToAppBoundDomains: false,
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      launchAutoHide: true,
      backgroundColor: "#07070b",
      showSpinner: false,
      androidScaleType: "CENTER_CROP",
    },
    SystemBars: {
      insetsHandling: "css",
      initialViewportFitValueHint: "cover",
      style: "DARK",
    },
  },
};

export default config;
