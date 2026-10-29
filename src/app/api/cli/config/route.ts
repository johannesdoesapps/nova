import { NextResponse } from "next/server";
import { getModels } from "@/lib/ai";
import { autoIdFor } from "@/lib/ai/platform";
import { usesNativeTools } from "@/lib/code/agent/engine";
import { CLI_DOWNLOAD_PATH, CLI_VERSION } from "@/lib/cli-version";
import { publicEnv } from "@/lib/env";
import { errorResponse } from "@/lib/http";

/**
 * GET /api/cli/config — public settings for the Orbis terminal app: where to sign in (the Supabase address and
 * publishable key, both already public in every page), the coding models it can use (only ones with native tool
 * calling, which the terminal app's agent loop needs) and the app's current version.
 */
export async function GET() {
  try {
    const models = (await getModels())
      .filter((m) => m.available && m.provider !== "demo" && usesNativeTools(m))
      .map((m) => ({ id: m.id, displayName: m.displayName, description: m.description, provider: m.provider, contextWindow: m.contextWindow, inputPrice: m.inputPrice, outputPrice: m.outputPrice, tier: m.tier ?? null, isDefault: !!m.isDefault }));
    return NextResponse.json(
      {
        supabaseUrl: publicEnv.supabaseUrl ?? null,
        supabaseKey: publicEnv.supabaseKey ?? null,
        autoModelId: autoIdFor("coding"),
        models,
        cli: { version: CLI_VERSION, download: CLI_DOWNLOAD_PATH },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
