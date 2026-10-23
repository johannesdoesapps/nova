import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { MEMORY_MAX_CHARS, MEMORY_MAX_ITEMS, addMemory, listMemories } from "@/lib/memory";

/** GET /api/memories — what Orbis remembers about the signed-in person. */
export async function GET() {
  try {
    const { supabase, user } = await requireUser();
    return NextResponse.json({ memories: await listMemories(supabase, user.id), max: MEMORY_MAX_ITEMS }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

const add = z.object({ content: z.string().trim().min(2).max(MEMORY_MAX_CHARS) });

/** POST /api/memories — remember one more fact. */
export async function POST(req: Request) {
  try {
    const { content } = await parseJsonBody(req, add, 2_000);
    const { supabase, user } = await requireUser();
    const r = await addMemory(supabase, user.id, content, "manual");
    if (!r.ok) {
      if (r.reason === "full") throw new ApiError("conflict", `Orbis keeps up to ${MEMORY_MAX_ITEMS} memories. Delete one to add another.`);
      if (r.reason === "duplicate") throw new ApiError("conflict", "That's already remembered.");
      throw new ApiError("bad_request", "Write something to remember.");
    }
    return NextResponse.json({ memory: r.memory });
  } catch (err) {
    return errorResponse(err);
  }
}

const del = z.object({ id: z.uuid().optional(), all: z.literal(true).optional() });

/** DELETE /api/memories — forget one memory ({ id }) or all of them ({ all: true }). */
export async function DELETE(req: Request) {
  try {
    const body = await parseJsonBody(req, del, 1_000);
    const { supabase, user } = await requireUser();
    if (!body.id && !body.all) throw new ApiError("bad_request", "Say which memory to delete.");
    let q = supabase.from("user_memories").delete().eq("user_id", user.id);
    if (body.id) q = q.eq("id", body.id);
    const { error } = await q;
    if (error) throw new ApiError("internal", "The memory couldn't be deleted. Try again.");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
