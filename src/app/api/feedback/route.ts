import { NextResponse } from "next/server";
import { trackEvent } from "@/lib/analytics/server";
import { feedbackDelete, feedbackRequest } from "@/lib/analytics/schema";
import { requireUser } from "@/lib/auth";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";

/** POST /api/feedback — rate a result (one rating per result; sending again changes it). */
export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req, feedbackRequest, 4_000);
    const auth = await requireUser();
    const { error } = await auth.supabase
      .from("response_feedback")
      .upsert(
        {
          user_id: auth.user.id,
          feature: body.feature,
          subject_id: body.subjectId,
          rating: body.rating,
          comment: body.comment || null,
          model_id: body.modelId ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,feature,subject_id" },
      );
    if (error) throw new ApiError("internal", "Couldn't save your feedback. Please try again.");
    if (body.rating === "helpful") trackEvent(auth, "useful_result", { how: "helpful", feature: body.feature === "agent" ? "agent" : body.feature });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/feedback?feature=…&subject=… — take a rating back. */
export async function DELETE(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const parsed = feedbackDelete.safeParse({ feature: params.get("feature"), subjectId: params.get("subject") });
    if (!parsed.success) throw new ApiError("bad_request", "Which feedback should be removed?");
    const auth = await requireUser();
    const { error } = await auth.supabase.from("response_feedback").delete().eq("user_id", auth.user.id).eq("feature", parsed.data.feature).eq("subject_id", parsed.data.subjectId);
    if (error) throw new ApiError("internal", "Couldn't remove your feedback.");
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
