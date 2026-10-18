import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { listArenas } from "@/lib/db/research";
import { errorResponse } from "@/lib/http";

export async function GET() {
  try {
    const auth = await requireUser();
    return NextResponse.json({ arenas: await listArenas(auth.supabase, auth.user.id) });
  } catch (err) {
    return errorResponse(err);
  }
}
