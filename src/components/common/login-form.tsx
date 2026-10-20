"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { browserSupabase } from "@/lib/supabase/client";
import { friendlyAuthError, LOGIN_MESSAGES, oauthErrorCode, oauthRedirectTo, RESET_PASSWORD_PATH } from "@/lib/auth-flow";
import { Button, Input, Notice } from "@/components/ui/primitives";

type Mode = "signin" | "signup";

const COPY: Record<Mode, { title: string; subtitle: string; divider: string }> = {
  signin: { title: "Welcome back to Orbis", subtitle: "Sign in to save conversations, searches and projects.", divider: "or continue with email" },
  signup: { title: "Create your Orbis account", subtitle: "Save conversations, searches and projects across devices.", divider: "or sign up with email" },
};

export function LoginForm({
  url,
  supabaseKey,
  next,
  siteUrl,
  initialMode = "signin",
  google,
  github = false,
}: {
  url: string;
  supabaseKey: string;
  next: string;
  siteUrl: string;
  initialMode?: Mode;
  /** Whether Google is switched on in Supabase Auth; null when that couldn't be checked. */
  google: boolean | null;
  /** Whether GitHub is switched on in Supabase Auth (the button is only shown then). */
  github?: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [githubBusy, setGithubBusy] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  // Blocks a second click before React re-renders the button as busy.
  const googleStarted = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const copy = COPY[mode];
  // Redirects go to the main site address, which is the one on Supabase's
  // redirect allow-list, even when signing in from a preview URL.
  const origin = () => (siteUrl.includes("localhost") && typeof window !== "undefined" ? window.location.origin : siteUrl);

  const continueWithGoogle = () => continueWith("google");
  const continueWith = async (provider: "google" | "github") => {
    if (googleStarted.current || busy) return;
    const setProviderBusy = provider === "google" ? setGoogleBusy : setGithubBusy;
    setError(null);
    setInfo(null);
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setError("You're offline. Check your connection and try again.");
      return;
    }
    googleStarted.current = true;
    setProviderBusy(true);
    try {
      // Supabase runs the OAuth flow with PKCE and checks state (and, for
      // Google, the OpenID nonce); Orbis never sees Google or GitHub credentials.
      const { error } = await browserSupabase(url, supabaseKey).auth.signInWithOAuth(
        provider === "google"
          ? {
              provider: "google",
              options: {
                redirectTo: oauthRedirectTo(origin(), next),
                // Always show Google's account chooser, so a shared device doesn't
                // silently continue as whoever used Google last.
                queryParams: { prompt: "select_account" },
              },
            }
          : // Only the public profile and email; repository access is granted separately, per repository.
            { provider: "github", options: { redirectTo: oauthRedirectTo(origin(), next, "github"), scopes: "read:user user:email" } },
      );
      if (error) throw error;
      // The browser is now leaving for the provider; keep the button busy until it does.
    } catch (e) {
      googleStarted.current = false;
      setProviderBusy(false);
      const m = String((e as Error)?.message ?? "");
      setError(/fetch|network/i.test(m) ? "Couldn't reach the sign-in service. Check your connection and try again." : LOGIN_MESSAGES[oauthErrorCode(m)].text);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    setInfo(null);
    const supabase = browserSupabase(url, supabaseKey);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.replace(next);
        router.refresh();
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { display_name: name.trim() || undefined },
            emailRedirectTo: `${origin()}/auth/callback?next=${encodeURIComponent(next)}`,
          },
        });
        if (error) throw error;
        if (data.session) {
          // Email confirmation is off: the new account is signed in straight away.
          router.replace(next);
          router.refresh();
        } else if (data.user && data.user.identities?.length === 0) {
          // Supabase hides whether an email is registered; an empty identity list means it already is.
          setMode("signin");
          setInfo("You already have an account with this email. Enter your password, or continue with Google if you used it before.");
        } else setInfo("Check your inbox to confirm your email, then sign in.");
      }
    } catch (e) {
      setError(friendlyAuthError((e as Error).message, mode));
    } finally {
      setBusy(false);
    }
  };

  // Emails a password reset link. The reply is the same whether or not an
  // account exists, so the form can't be used to discover who has signed up.
  const forgotPassword = async () => {
    setError(null);
    setInfo(null);
    if (!email.trim()) {
      setError("Enter your email above, then choose “Forgot password?” again.");
      return;
    }
    setResetBusy(true);
    try {
      const { error } = await browserSupabase(url, supabaseKey).auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${origin()}/auth/callback?next=${encodeURIComponent(RESET_PASSWORD_PATH)}`,
      });
      if (error) throw error;
      setInfo("If an account exists for that email, we’ve sent a link to reset your password.");
    } catch (e) {
      setError(friendlyAuthError((e as Error)?.message, "reset"));
    } finally {
      setResetBusy(false);
    }
  };

  return (
    <div>
      <h1 className="font-serif text-[34px] leading-[1.05] tracking-[-0.01em]">{copy.title}</h1>
      <p className="mt-1 text-sm text-muted">{copy.subtitle}</p>

      <div className="mt-5">
        <GoogleButton onClick={() => void continueWithGoogle()} loading={googleBusy} disabled={google === false || busy} />
        {google === false && (
          <p className="mt-2 text-center text-xs text-muted">Google sign-in isn&rsquo;t set up on this site yet. Use your email below.</p>
        )}
        {github && (
          <Button
            type="button"
            variant="outline"
            className="mt-2 w-full bg-bg-elev focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={() => void continueWith("github")}
            loading={githubBusy}
            disabled={busy || googleBusy}
            aria-busy={githubBusy}
          >
            {!githubBusy && <GitHubLogo />}
            <span>{githubBusy ? "Opening GitHub…" : "Continue with GitHub"}</span>
          </Button>
        )}
      </div>

      <div className="my-5 flex items-center gap-3 text-xs text-muted" role="separator" aria-label={copy.divider}>
        <span className="h-px flex-1 bg-border" aria-hidden />
        <span aria-hidden>{copy.divider}</span>
        <span className="h-px flex-1 bg-border" aria-hidden />
      </div>

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {mode === "signup" && (
          <label className="block">
            <span className="mb-1 block text-xs text-muted">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" />
          </label>
        )}
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Email</span>
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Password</span>
          <Input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "signin" ? "current-password" : "new-password"} />
        </label>
        {mode === "signin" && (
          <div className="-mt-1 text-right text-xs">
            <button
              type="button"
              onClick={() => void forgotPassword()}
              disabled={resetBusy || busy}
              className="rounded text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
            >
              {resetBusy ? "Sending link…" : "Forgot password?"}
            </button>
          </div>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        {info && <Notice tone="success">{info}</Notice>}
        <Button type="submit" className="w-full" loading={busy} disabled={googleBusy}>{mode === "signin" ? "Sign in" : "Create account"}</Button>
        <p className="text-center text-xs text-muted">
          {mode === "signin" ? "Don’t have an account?" : "Already have an account?"}{" "}
          <button
            type="button"
            className="rounded text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setError(null);
              setInfo(null);
            }}
          >
            {mode === "signin" ? "Sign up" : "Sign in"}
          </button>
        </p>
      </form>
    </div>
  );
}

/** "Continue with Google" in Google's neutral button style, with the standard multicolour G. */
function GoogleButton({ onClick, loading, disabled }: { onClick: () => void; loading: boolean; disabled: boolean }) {
  return (
    <Button
      type="button"
      variant="outline"
      className="w-full bg-bg-elev focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      onClick={onClick}
      loading={loading}
      disabled={disabled}
      aria-busy={loading}
    >
      {!loading && <GoogleLogo />}
      <span>{loading ? "Opening Google…" : "Continue with Google"}</span>
    </Button>
  );
}

export function GitHubLogo({ className = "h-[18px] w-[18px]" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden focusable="false" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function GoogleLogo() {
  return (
    <svg viewBox="0 0 48 48" className="h-[18px] w-[18px]" aria-hidden focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
