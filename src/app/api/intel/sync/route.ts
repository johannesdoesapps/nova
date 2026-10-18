import { NextResponse } from "next/server";
import { getModels } from "@/lib/ai";
import { requireUserIfConfigured } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { syncProviders } from "@/lib/intel/provider-sync";
import { enforceLimits } from "@/lib/usage";

/** POST /api/intel/sync — compare the registry with providers' model-list APIs (no model calls, no cost). */
export async function POST(req: Request) {
  try {
    const auth = await requireUserIfConfigured();
    await enforceLimits(req, auth, 1);
    return NextResponse.json({ listings: await syncProviders(await getModels()) });
  } catch (err) {
    return errorResponse(err);
  }
}
