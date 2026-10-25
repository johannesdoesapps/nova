import { describe, expect, it } from "vitest";
import { backButtonAction, deepLinkTarget, isExternalUrl, nativeOAuthRedirect, nativePlatform } from "@/lib/native/bridge";

const SITE = "https://tryorbis.app";
const cap = (native: boolean, platform: string) => ({ Capacitor: { isNativePlatform: () => native, getPlatform: () => platform } });

describe("nativePlatform", () => {
  it("is null in a browser and on the server", () => {
    expect(nativePlatform(undefined)).toBeNull();
    expect(nativePlatform({})).toBeNull();
    expect(nativePlatform(cap(false, "web"))).toBeNull();
  });
  it("names the platform inside the app", () => {
    expect(nativePlatform(cap(true, "ios"))).toBe("ios");
    expect(nativePlatform(cap(true, "android"))).toBe("android");
    expect(nativePlatform(cap(true, "electron"))).toBeNull();
  });
});

describe("isExternalUrl", () => {
  it("keeps Orbis links in the app", () => {
    expect(isExternalUrl("/chat", SITE)).toBe(false);
    expect(isExternalUrl("https://tryorbis.app/pricing", SITE)).toBe(false);
    expect(isExternalUrl("#top", SITE)).toBe(false);
    expect(isExternalUrl("javascript:alert(1)", SITE)).toBe(false);
  });
  it("sends other sites, mail and phone links out", () => {
    expect(isExternalUrl("https://github.com/x/y", SITE)).toBe(true);
    expect(isExternalUrl("https://evil.tryorbis.app.example.com/", SITE)).toBe(true);
    expect(isExternalUrl("mailto:support@tryorbis.app", SITE)).toBe(true);
    expect(isExternalUrl("tel:+15555550100", SITE)).toBe(true);
  });
});

describe("nativeOAuthRedirect", () => {
  it("returns to the app scheme and keeps a safe next page", () => {
    expect(nativeOAuthRedirect("/code?x=1")).toBe("app.tryorbis.orbis://auth/callback?via=google&next=%2Fcode%3Fx%3D1");
    expect(nativeOAuthRedirect("/")).toBe("app.tryorbis.orbis://auth/callback?via=google");
  });
  it("drops unsafe next values", () => {
    expect(nativeOAuthRedirect("//evil.example")).toBe("app.tryorbis.orbis://auth/callback?via=google");
    expect(nativeOAuthRedirect("https://evil.example")).toBe("app.tryorbis.orbis://auth/callback?via=google");
  });
});

describe("deepLinkTarget", () => {
  it("maps sign-in returns onto the server callback", () => {
    const t = deepLinkTarget("app.tryorbis.orbis://auth/callback?code=abc&via=google&next=%2Fcode");
    expect(t).toBe("/auth/callback?code=abc&via=google&next=%2Fcode");
    expect(deepLinkTarget("app.tryorbis.orbis://auth/callback/?error=access_denied&error_description=No")).toBe("/auth/callback?error=access_denied&error_description=No");
  });
  it("keeps the PKCE flow id and error code the server callback reads", () => {
    expect(deepLinkTarget("app.tryorbis.orbis://auth/callback?code=abc&sb_flow_id=f1")).toBe("/auth/callback?code=abc&sb_flow_id=f1");
    expect(deepLinkTarget("app.tryorbis.orbis://auth/callback?error=server_error&error_code=bad_oauth_state")).toBe("/auth/callback?error=server_error&error_code=bad_oauth_state");
  });
  it("drops unknown parameters and unsafe next values", () => {
    expect(deepLinkTarget("app.tryorbis.orbis://auth/callback?code=abc&next=//evil.example&redirect=https://x")).toBe("/auth/callback?code=abc&next=%2F");
  });
  it("opens same-site paths", () => {
    expect(deepLinkTarget("app.tryorbis.orbis://open/chat?c=1")).toBe("/chat?c=1");
    expect(deepLinkTarget("app.tryorbis.orbis://open")).toBe("/home");
    expect(deepLinkTarget("https://tryorbis.app/code/abc")).toBe("/code/abc");
  });
  it("ignores everything else", () => {
    expect(deepLinkTarget("app.tryorbis.orbis://settings/delete")).toBeNull();
    expect(deepLinkTarget("https://evil.example/chat")).toBeNull();
    expect(deepLinkTarget("other.scheme://open/chat")).toBeNull();
    expect(deepLinkTarget("not a url")).toBeNull();
    expect(deepLinkTarget("app.tryorbis.orbis://open//evil.example")).toBe("/home");
  });
});

describe("backButtonAction", () => {
  it("goes back when it can, otherwise leaves the app", () => {
    expect(backButtonAction(true)).toBe("back");
    expect(backButtonAction(false)).toBe("exit");
  });
});
