"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { WifiOff } from "lucide-react";
import { backButtonAction, deepLinkTarget, isExternalUrl, nativePlatform, NATIVE_PURCHASE_NOTE, type NativePlatform } from "@/lib/native/bridge";

/**
 * Glue for the Orbis mobile apps (see lib/native/bridge.ts). Mounted once in the root layout; in a normal browser
 * it only shows the offline notice. Inside the app it:
 * - marks <html data-native="ios|android"> for small layout differences;
 * - opens links to other sites in the in-app browser (Safari View Controller / Custom Tabs) instead of replacing Orbis;
 * - handles the Android back button and deep links (sign-in returns, `app.tryorbis.orbis://open/...`).
 */

type Remove = () => void;
interface NativeBridgeGlobal {
  PluginHeaders?: { name: string }[];
  nativePromise?: (plugin: string, method: string, options?: object) => Promise<unknown>;
  nativeCallback?: (plugin: string, method: string, options: object, callback: (data: unknown) => void) => string | undefined;
}

// The shell injects Capacitor's native bridge (window.Capacitor with nativePromise/nativeCallback) into every page it
// loads, but not @capacitor/core's plugin objects: the website doesn't bundle Capacitor. These two helpers make the
// same calls the plugin objects would.
function bridge(plugin: string): NativeBridgeGlobal | null {
  if (!nativePlatform()) return null;
  const cap = (window as { Capacitor?: NativeBridgeGlobal }).Capacitor;
  return cap?.PluginHeaders?.some((h) => h.name === plugin) ? cap : null;
}

/** Call a native plugin method; resolves to null in a browser or when the plugin isn't in the app. */
export async function callNative<T = unknown>(plugin: string, method: string, options: object = {}): Promise<T | null> {
  const cap = bridge(plugin);
  if (!cap?.nativePromise) return null;
  return (await cap.nativePromise(plugin, method, options)) as T;
}

/** Listen to a native plugin event; returns the function that stops listening (a no-op in a browser). */
export function onNative<T>(plugin: string, eventName: string, callback: (data: T) => void): Remove {
  const cap = bridge(plugin);
  if (!cap?.nativeCallback) return () => {};
  const cb = (data: unknown) => callback(data as T);
  const callbackId = cap.nativeCallback(plugin, "addListener", { eventName }, cb);
  return () => {
    if (callbackId) cap.nativeCallback?.(plugin, "removeListener", { eventName, callbackId }, cb);
  };
}

/** Open a URL outside Orbis: the in-app browser in the app, a new tab on the web. */
export async function openExternal(url: string): Promise<void> {
  if (bridge("Browser")) await callNative("Browser", "open", { url, presentationStyle: "popover" });
  else window.open(url, "_blank", "noopener,noreferrer");
}

const subscribeNothing = () => () => {};
/** "ios" / "android" inside the app, null in a browser (and during server rendering). */
export function useNativePlatform(): NativePlatform | null {
  return useSyncExternalStore(subscribeNothing, () => nativePlatform(), () => null);
}

/** Shown in place of purchase buttons inside the store apps. */
export function NativePurchaseNote({ className }: { className?: string }) {
  return (
    <p role="note" className={className ?? "text-[13px] leading-relaxed text-muted"}>
      {NATIVE_PURCHASE_NOTE}
    </p>
  );
}

/** Renders its children on the web only: purchase calls to action that the store apps may not show. */
export function WebOnly({ children }: { children: React.ReactNode }) {
  return useNativePlatform() ? null : <>{children}</>;
}

function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("online", cb);
      window.addEventListener("offline", cb);
      return () => {
        window.removeEventListener("online", cb);
        window.removeEventListener("offline", cb);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

export function NativeBridge() {
  const router = useRouter();
  const platform = useNativePlatform();
  const online = useOnline();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!platform) return;
    document.documentElement.dataset.native = platform;
    const stops: Remove[] = [];

    // Links to other sites open in the in-app browser.
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.hasAttribute("download")) return;
      const href = a.getAttribute("href") ?? "";
      if (!isExternalUrl(href, location.origin)) return;
      e.preventDefault();
      void openExternal(new URL(href, location.origin).toString());
    };
    document.addEventListener("click", onClick, true);

    stops.push(
      onNative<{ canGoBack: boolean }>("App", "backButton", ({ canGoBack }) => {
        if (backButtonAction(canGoBack) === "back") window.history.back();
        else void callNative("App", "exitApp");
      }),
      onNative<{ url: string }>("App", "appUrlOpen", ({ url }) => {
        const target = deepLinkTarget(url, location.origin);
        if (!target) return;
        void callNative("Browser", "close").catch(() => {});
        // Sign-in returns go through the server route (it sets the session cookies), so load it fully.
        if (target.startsWith("/auth/callback")) window.location.assign(target);
        else router.push(target);
      }),
    );

    // Status bar text follows the site theme (light text on the dark theme, dark text on the light one).
    const html = document.documentElement;
    const syncBars = () => void callNative("SystemBars", "setStyle", { style: html.dataset.theme === "light" ? "LIGHT" : "DARK" }).catch(() => {});
    syncBars();
    const themeWatch = new MutationObserver(syncBars);
    themeWatch.observe(html, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      document.removeEventListener("click", onClick, true);
      themeWatch.disconnect();
      for (const stop of stops) stop();
    };
  }, [platform, router]);

  if (online || dismissed) return null;
  return (
    <div role="status" className="fixed inset-x-0 top-0 z-[90] flex justify-center px-3 pt-[max(8px,env(safe-area-inset-top))]">
      <div className="flex items-center gap-2 rounded-full border border-border bg-bg/95 px-3.5 py-2 text-[13px] text-fg shadow-lg backdrop-blur">
        <WifiOff className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        You&apos;re offline. Orbis will reconnect when your connection is back; nothing you typed is lost.
        <button type="button" onClick={() => setDismissed(true)} className="ml-1 min-h-8 rounded-full px-2 text-muted hover:text-fg" aria-label="Dismiss">
          ✕
        </button>
      </div>
    </div>
  );
}
