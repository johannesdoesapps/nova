import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuth } from "@/lib/auth";
import { deleteBenchmarkRun, deleteTrial, listBenchmarkRuns, listTrials, listUsage } from "@/lib/db/research";
import { errorResponse, parseQuery } from "@/lib/http";

/** GET /api/intel/history — trials, benchmark runs and 30-day usage for the signed-in user. Guests keep history locally. */
export async function GET() {
  try {
    const auth = await getAuth();
    if (auth.mode !== "authenticated") return NextResponse.json({ guest: true, trials: [], benchmarks: [], usage: [] });
    const [trials, benchmarks, usage] = await Promise.all([
      listTrials(auth.supabase, auth.user.id),
      listBenchmarkRuns(auth.supabase, auth.user.id),
      listUsage(auth.supabase, auth.user.id),
    ]);
    return NextResponse.json({ guest: false, trials, benchmarks, usage }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

const delQuery = z.object({ kind: z.enum(["trial", "benchmark"]), id: z.uuid() });

/** DELETE /api/intel/history?kind=trial|benchmark&id=… — remove one piece of evidence. */
export async function DELETE(req: Request) {
  try {
    const q = parseQuery(req.url, delQuery);
    const auth = await getAuth();
    if (auth.mode !== "authenticated") return new NextResponse(null, { status: 204 });
    if (q.kind === "trial") await deleteTrial(auth.supabase, auth.user.id, q.id);
    else await deleteBenchmarkRun(auth.supabase, auth.user.id, q.id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
