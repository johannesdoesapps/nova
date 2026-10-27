import { after, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { sendSignupWelcome } from "@/lib/email";
import { errorResponse } from "@/lib/http";

/**
 * POST /api/account/welcome — called by the sign-up form when the new account is signed in straight away (email
 * confirmation off). Sends the welcome email after the response, at most once per account and only to accounts
 * created in the last week, so calling it again (or from an old account) does nothing. Sign-ups that go through the
 * confirmation link or Google/GitHub are welcomed by /auth/callback instead.
 */
export async function POST() {
  try {
    const { user } = await requireUser();
    after(() => sendSignupWelcome(user.id));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
