"use client";
import { STATUS_LABEL, type ConnectionStatus } from "@/lib/connectors/catalog";
import { cn } from "@/lib/utils";

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" });
  const body = await res.json().catch(() => null);
  if (!res.ok && !(body && "ok" in body)) throw new Error(body?.error?.message ?? `Request failed (${res.status}).`);
  return body as T;
}

const TONE: Record<ConnectionStatus, string> = {
  not_connected: "border-s-line text-s-ink-3",
  connecting: "border-s-line text-s-ink-2",
  connected: "border-emerald-500/40 text-emerald-600",
  reauth_required: "border-amber-500/50 text-amber-600",
  error: "border-red-500/40 text-s-danger",
  disconnected: "border-s-line text-s-ink-3",
};

export function StatusPill({ status }: { status: ConnectionStatus }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]", TONE[status])}>
      <span className={cn("h-1.5 w-1.5 rounded-full", status === "connected" ? "bg-emerald-500" : status === "reauth_required" ? "bg-amber-500" : status === "error" ? "bg-red-500" : "bg-s-ink-3/60")} />
      {STATUS_LABEL[status]}
    </span>
  );
}

