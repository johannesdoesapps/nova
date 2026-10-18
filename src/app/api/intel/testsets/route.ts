import { NextResponse } from "next/server";
import { BUILT_IN_TEST_SETS, testSetHash } from "@/lib/intel/testsets";

/** GET /api/intel/testsets — built-in reproducible test sets with their content hashes. */
export async function GET() {
  return NextResponse.json(
    { testSets: BUILT_IN_TEST_SETS.map((t) => ({ ...t, hash: testSetHash(t) })) },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}
