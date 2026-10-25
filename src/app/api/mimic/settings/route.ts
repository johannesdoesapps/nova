import { NextResponse } from "next/server";
import { z } from "zod";
import { codeContext } from "@/lib/code/server";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { deleteAllData, updateSettings } from "@/lib/mimic/server";

/** PATCH /api/mimic/settings — the emergency stop, AI reading and data retention. */
export async function PATCH(req: Request) {
  try {
    const body = await parseJsonBody(req, z.object({ stopped: z.boolean().optional(), aiReading: z.boolean().optional(), retentionDays: z.number().int().min(30).max(3650).optional() }), 2_000);
    const auth = await codeContext("mimic-write", 60);
    return NextResponse.json({ settings: await updateSettings(auth, body) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/mimic/settings — delete everything Mimic stores for you (body: {"confirm": "DELETE"}). */
export async function DELETE(req: Request) {
  try {
    await parseJsonBody(req, z.object({ confirm: z.literal("DELETE") }), 200);
    const auth = await codeContext("mimic-write", 10);
    await deleteAllData(auth);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
