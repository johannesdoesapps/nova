import { NextResponse } from "next/server";
import { requireOperator, wfError } from "@/lib/workforce/server";

/** GET /api/workforce/approvals — pending approvals across tasks. */
export async function GET() {
  try {
    const { store } = await requireOperator();
    return NextResponse.json({ approvals: await store.listApprovals({ status: "pending" }) });
  } catch (err) {
    return wfError(err);
  }
}
