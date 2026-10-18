import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { addFavorite, listFavorites, removeFavorite } from "@/lib/db";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { favoriteRequest } from "@/lib/validation";

export async function GET() {
  try {
    const { supabase, user } = await requireUser();
    return NextResponse.json({ favorites: await listFavorites(supabase, user.id) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req, favoriteRequest, 2_000);
    const { supabase, user } = await requireUser();
    await addFavorite(supabase, user.id, body.modelId, body.source);
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: Request) {
  try {
    const body = await parseJsonBody(req, favoriteRequest, 2_000);
    const { supabase, user } = await requireUser();
    await removeFavorite(supabase, user.id, body.modelId);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
