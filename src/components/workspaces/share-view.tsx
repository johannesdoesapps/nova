"use client";
import { Badge, Card, Notice } from "@/components/ui/primitives";
import { useEngine } from "@/components/engine/api";
import { isSafeHttpUrl, relativeTime } from "@/lib/utils";

export function ShareView({ token }: { token: string }) {
  const s = useEngine<{ workspace: { name: string; description: string | null }; role: string; items: { id: string; type: string; title: string; data: Record<string, unknown>; updated_at: string }[] }>(`share/${token}`);
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <div className="mb-1 text-xs uppercase tracking-wider text-faint">Shared from Orbis AI · read-only</div>
      {s.error && <Notice tone="danger">{s.error}</Notice>}
      {s.data && (
        <>
          <h1 className="text-2xl font-semibold">{s.data.workspace.name}</h1>
          {s.data.workspace.description && <p className="mt-1 text-muted">{s.data.workspace.description}</p>}
          <div className="mt-6 space-y-3">
            {s.data.items.map((i) => (
              <Card key={i.id} className="p-4">
                <div className="flex items-center gap-2 text-xs"><Badge>{i.type}</Badge><span className="text-faint">updated {relativeTime(i.updated_at)}</span></div>
                <div className="mt-1 font-medium">{i.title}</div>
                {typeof i.data.body === "string" && <p className="mt-2 whitespace-pre-wrap text-sm text-muted">{i.data.body}</p>}
                {typeof i.data.decision === "string" && <p className="mt-2 text-sm"><b>Decision:</b> {i.data.decision} {typeof i.data.rationale === "string" && <span className="text-muted">— {i.data.rationale}</span>}</p>}
                {isSafeHttpUrl(i.data.url) && <a href={String(i.data.url)} target="_blank" rel="noopener noreferrer nofollow" className="mt-2 block text-sm text-accent">{String(i.data.url)}</a>}
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
