import { codeContext } from "@/lib/code/server";
import { errorResponse, requireUuid } from "@/lib/http";
import { toMarkdown } from "@/lib/research/research";
import { getResearch } from "@/lib/research/server";

/** GET /api/research/[id]/export — the report, its sources and method as a Markdown file. */
export async function GET(_req: Request, ctx: RouteContext<"/api/research/[id]/export">) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("research-read", 60);
    const run = await getResearch(auth, id);
    const name =
      run.question
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 60)
        .toLowerCase() || "research";
    return new Response(toMarkdown(run), { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.md"`, "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
