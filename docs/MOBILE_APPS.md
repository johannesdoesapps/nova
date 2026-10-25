# Orbis mobile apps (iOS and Android)

Status as of 2026-10-25, branch `mobile-app-2026-10`. Nothing here is deployed or submitted to a store yet.

## How the apps work

Orbis is a Next.js app with server rendering and API routes (sign-in, AI requests, usage limits, billing checks), so
it can't be exported as static files and bundled into an app. The apps are a **Capacitor 8 shell that loads
https://tryorbis.app** in the platform web view (WKWebView on iOS, Android System WebView), plus native glue:

| Piece | Where | What it does |
| --- | --- | --- |
| Capacitor project | `mobile/` (own `package.json`) | Native projects, config, icons, splash, offline page. The web app does not depend on it. |
| Config | `mobile/capacitor.config.ts` | `server.url` = https://tryorbis.app, offline page `www/error.html`, allowed in-app hosts, splash and system-bar settings. |
| Offline page | `mobile/www/error.html` | Shown by the shell when the site can't load: explains, Retry button, retries by itself when the connection returns. |
| Pure rules | `src/lib/native/bridge.ts` | Platform detection, external-link test, deep-link mapping, Google return address, back-button rule. Unit-tested in `tests/native-bridge.test.ts`. |
| Browser glue | `src/components/common/native-bridge.tsx` | Mounted once in the root layout. In a normal browser it only shows the offline notice. In the app it opens other sites in the in-app browser, handles the Android back button and deep links, matches the status-bar text to the theme, and hides purchase UI. |

The website does **not** bundle Capacitor. The shell injects `window.Capacitor` (with `nativePromise` /
`nativeCallback`) into pages from tryorbis.app only, and the web code calls the App, Browser and SystemBars
plugins through it. In any ordinary browser `window.Capacitor` is absent and every native code path is skipped.

### Sign-in

- **Email/password and GitHub** run inside the app's web view. GitHub sign-in goes tryorbis.app → Supabase →
  github.com → back to `/auth/callback`; those two hosts are in `allowNavigation`, so the PKCE verifier cookie and
  the returned code stay in the same cookie jar. Sessions use the same Supabase cookies as the website.
- **Google** refuses sign-in inside embedded web views, so in the app the login form asks Supabase for the Google
  URL (`skipBrowserRedirect`) and opens it in the in-app browser (Safari View Controller / Chrome Custom Tabs). Google
  returns to `app.tryorbis.orbis://auth/callback?code=…`; the app maps that to `/auth/callback?code=…` and loads it in
  the web view, where the server exchanges the code using the verifier the web view stored. Only `code`,
  `sb_flow_id`, `error`, `error_code`, `error_description`, `via` and a same-site `next` are passed on.

### Deep links

- `app.tryorbis.orbis://auth/callback?…`: sign-in returns (see above).
- `app.tryorbis.orbis://open/<path>`: opens `/<path>` in the app (same-site paths only; anything else is ignored).
- `https://tryorbis.app/<path>` links are handled the same way **once universal links / app links are set up**,
  which needs details only the account owner has (see "Still to do").

### Purchases

Apple (guideline 3.1.1) and Google Play (Payments policy) require their own billing for digital subscriptions sold
inside an app. Orbis sells plans and extra usage through Stripe on the website, so **inside the apps every purchase
control is hidden** and replaced by: "Plans and extra usage can't be bought in the app. You can manage them on
tryorbis.app in a web browser; your plan works everywhere you sign in." This covers the plan buttons on Pricing
(shown once at the top instead), Manage subscription, Extra usage and Automatic top-ups, Start a team, and the
"Upgrade to …" links on Usage. Plans, limits and entitlements are unchanged; a plan bought on the web works in the
app because entitlements are checked on the server.

## Building

Prerequisites: Node 22+; Android Studio or the Android SDK (platform 36) with JDK 21; for iOS a Mac with a current
Xcode release supported by Capacitor 8 (see https://capacitorjs.com/docs/getting-started/environment-setup).

```bash
cd mobile
npm ci
npx cap sync               # copies config + offline page into both native projects
```

Android (debug APK, signed with the local debug key):

```bash
export ANDROID_HOME=~/Android/Sdk      # wherever the SDK is
npm run android:debug                  # → android/app/build/outputs/apk/debug/app-debug.apk
```

iOS:

```bash
npm run ios:open                       # opens ios/App/App.xcodeproj in Xcode; pick a simulator or device, Run
```

Icons and splash screens come from `mobile/assets/` (rendered from the same mark as `/app-icon`). After changing the
mark: `node scripts/brand-assets.cjs && npm run assets && npx cap sync`.

To point a build at another deployment (e.g. a Vercel preview) set `ORBIS_APP_URL` when running `npx cap sync`.
Sign-in only works on a host whose `/auth/callback` is in the Supabase redirect allow-list.

## Releasing

### Android (Google Play)

1. Create an upload key once and keep it safe (losing it means contacting Play support):
   `keytool -genkeypair -v -keystore orbis-upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias orbis-upload`
2. Create `mobile/android/keystore.properties` (git-ignored, never commit it) with `storeFile`, `storePassword`,
   `keyAlias`, `keyPassword`. `app/build.gradle` picks it up automatically; without it release builds are unsigned.
3. Raise `versionCode` (integer, +1 every upload) and `versionName` in `mobile/android/app/build.gradle`.
4. `npm run android:release` → `android/app/build/outputs/bundle/release/app-release.aab`.
5. Play Console: create the app (`app.tryorbis.orbis`), enrol in Play App Signing, upload the bundle to Internal
   testing first, fill in the Data safety form (match the Privacy Policy), content rating, and target audience.

### iOS (App Store)

1. Apple Developer Program membership; in Xcode set the Team for the `App` target (bundle id `app.tryorbis.orbis`).
   Automatic signing creates the certificates and provisioning profiles; for CI, export a distribution certificate
   and an App Store provisioning profile.
2. Raise the version and build number in Xcode (target → General).
3. Product → Archive → Distribute App → App Store Connect. Test through TestFlight before review.
4. App Store Connect: privacy nutrition labels (match the Privacy Policy), screenshots, review notes with a demo
   account the reviewer can use.

`Info.plist` declares `ITSAppUsesNonExemptEncryption = false` because the app only uses standard HTTPS; change it if
that ever stops being true.

## Before submitting: owner actions

| Item | Why | Who |
| --- | --- | --- |
| Deploy the web changes on this branch | The app's link handling, Google sign-in, back button and purchase hiding live in the website code. Until they are live, the app is a plain web view and Google sign-in fails inside it. | Owner approves deploy |
| Add `app.tryorbis.orbis://auth/callback` to Supabase → Authentication → URL Configuration → Redirect URLs | Supabase refuses to return to an address that isn't listed, so Google sign-in from the app fails without it. | Owner (dashboard) |
| In-app account deletion | Apple 5.1.1(v): apps that let people create accounts must let them start deleting the account inside the app. Orbis currently handles deletion by email. A self-service flow has to cancel any Stripe subscription and delete data in order, so it was not built without sign-off. | Needs a decision, then build |
| In-app purchase decision for iOS | Apple may still reject an app that hides purchasing entirely (3.1.3(b) "multiplatform services" expects the in-app purchase option too). The alternative, StoreKit subscriptions, needs App Store Connect products, server-side receipt checks and entitlement mapping. Not built. | Owner decision |
| Minimum functionality (Apple 4.2) | Apps that mostly show a website can be rejected. Native sign-in handling, deep links, offline page and system integration help, but review is not guaranteed. Push notifications (below) would strengthen it. | Risk to note |

## Still to do (not built)

- **Universal links / Android App Links** (`https://tryorbis.app/...` opening the app). Needs the Apple Team ID
  (for `/.well-known/apple-app-site-association` plus the Associated Domains entitlement) and the SHA-256
  fingerprint of the Play app-signing key (for `/.well-known/assetlinks.json` plus an `autoVerify` intent filter).
- **Push notifications.** Not implemented. Needs an FCM project (`google-services.json`), an APNs key, the
  `@capacitor/push-notifications` plugin, a device-token table with row-level security, a permission prompt at a
  sensible moment, and a server-side sender (keys only on the server). The obvious first use is "your agent task
  finished".
- **Biometric lock, share sheet, file pickers beyond the web view's own**: not built.

## Security notes

- No API keys or secrets are in the app or in `mobile/`; the app talks to the same server APIs as the website.
- `allowNavigation` is limited to the Supabase project host and github.com; everything else opens outside the app.
  On Android the bridge is injected only into tryorbis.app pages.
- Cleartext HTTP and mixed content are off; Android backups are off, so session cookies aren't copied to cloud backups.
- Release builds disable web-view debugging (`webContentsDebuggingEnabled: false`).
- `npm audit` in `mobile/` reports issues only in build-time tools (`@capacitor/cli`, `@capacitor/assets` →
  `tar`, `sharp`, `xcode`); `npm audit --omit=dev` reports none for what ships in the app.

## What was tested (2026-10-25)

- `tests/native-bridge.test.ts`: 12 unit tests (platform detection, external links, deep-link mapping including
  unsafe `next` values and foreign hosts, Google return address, back button).
- `npx cap add android/ios`, `npx cap sync`: succeeded.
- `./gradlew assembleDebug` and `bundleRelease`: succeeded (debug APK signed with the debug key; release bundle
  unsigned because no upload key exists here). The APK's manifest was checked: package `app.tryorbis.orbis`, target
  SDK 36, deep-link intent filter, backups off.
- Not run: the APK on a device or emulator (no hardware virtualisation in the build environment), and no iOS build
  (needs macOS and Xcode).
- In-app web behaviour was checked in Chromium with a simulated Capacitor bridge against a local build: 25 of 25
  checks passed (native marker, back button, deep links, external links in the in-app browser, Google sign-in
  opening the in-app browser with the app return address, cancelled sign-in message, purchase UI hidden in the app
  and still present on the web, offline banner).
