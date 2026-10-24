import { NextResponse } from "next/server";
import { getAllModels, providerConfiguredMap } from "@/lib/ai";
import { parsePlatformSettings, platformSettingsSchema } from "@/lib/ai/platform";
import { PROVIDER_INFO } from "@/lib/ai/provider-info";
import { getPlatformSettings } from "@/lib/ai/settings";
import { requireAdmin } from "@/lib/admin";
import { getAuth } from "@/lib/auth";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { validateBilling } from "@/lib/plans";

async function snapshot() {
  const settings = await getPlatformSettings();
  const configured = providerConfiguredMap();
  const models = (await getAllModels(settings)).filter((m) => m.provider !== "demo");
  return { settings, models, providers: (Object.keys(PROVIDER_INFO) as (keyof typeof PROVIDER_INFO)[]).map((id) => ({ id, ...PROVIDER_INFO[id], configured: configured[id] })) };
}

/** GET /api/admin/settings — platform AI settings, all registered models and provider status (admins only). */
export async function GET() {
  try {
    await requireAdmin(await getAuth());
    return NextResponse.json(await snapshot(), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PUT /api/admin/settings — replace platform settings. Validated here and enforced again by RLS. */
export async function PUT(req: Request) {
  try {
    const auth = await requireAdmin(await getAuth());
    const next = await parseJsonBody(req, platformSettingsSchema, 220_000);
    const known = new Set((await getAllModels(next)).map((m) => m.id));
    if (next.defaultModelId && !known.has(next.defaultModelId)) throw new ApiError("bad_request", "The default model isn't in the registry.");
    if (next.defaultModelId && next.enabledModelIds && !next.enabledModelIds.includes(next.defaultModelId)) {
      throw new ApiError("bad_request", "Enable the default model, or choose a different default.");
    }
    if (next.enabledModelIds?.length === 0) throw new ApiError("bad_request", "Enable at least one model.");
    if (next.billing) {
      const b = validateBilling(next.billing);
      if (!b.ok) throw new ApiError("bad_request", b.error);
      next.billing = b.billing as unknown as Record<string, unknown>;
    }
    // Paused agents are managed in the agent directory; a save from this page (which may hold an older copy) keeps them as stored.
    const { data: stored, error: readError } = await auth.supabase.from("app_settings").select("settings").eq("id", 1).maybeSingle();
    if (readError) throw new ApiError("internal", "The settings could not be saved.");
    next.pausedAgents = parsePlatformSettings(((stored as { settings?: unknown } | null)?.settings ?? {}) as Record<string, unknown>).pausedAgents;
    const { data, error } = await auth.supabase.from("app_settings").update({ settings: next, updated_by: auth.user.id }).eq("id", 1).select("id");
    if (error || !data?.length) throw new ApiError("internal", "The settings could not be saved.");
    return NextResponse.json(await snapshot());
  } catch (err) {
    return errorResponse(err);
  }
}
