import "server-only";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { reportError } from "./observability";

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "plan_required"
  | "payment_required"
  | "payload_too_large"
  | "rate_limited"
  | "quota_exceeded"
  | "not_configured"
  | "upstream_error"
  | "timeout"
  | "internal";

const STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  plan_required: 403,
  payment_required: 402,
  payload_too_large: 413,
  rate_limited: 429,
  quota_exceeded: 429,
  not_configured: 503,
  upstream_error: 502,
  timeout: 504,
  internal: 500,
};

export class ApiError extends Error {
  constructor(
    public code: ApiErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Consistent error envelope: { error: { code, message, details? } } */
export function errorResponse(err: unknown, headers?: HeadersInit): NextResponse {
  if (err instanceof ApiError) {
    // Server-side failures are logged so they show up in monitoring; user errors (4xx) aren't noise.
    if (STATUS[err.code] >= 500 && err.code !== "not_configured") reportError(err, { code: err.code });
    return NextResponse.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      { status: STATUS[err.code], headers },
    );
  }
  reportError(err);
  return NextResponse.json(
    { error: { code: "internal", message: "Something went wrong. Please try again." } },
    { status: 500, headers },
  );
}

export async function parseJsonBody<T extends z.ZodType>(
  req: Request,
  schema: T,
  maxBytes = 64_000,
): Promise<z.infer<T>> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > maxBytes) throw new ApiError("payload_too_large", `Request body exceeds ${maxBytes} bytes.`);
  const text = await readBodyLimited(req, maxBytes);
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError("bad_request", "Request body must be valid JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      "bad_request",
      "Invalid request.",
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return parsed.data;
}

/** Read a body as text, stopping as soon as it passes maxBytes (a missing or false Content-Length can't bypass the limit). */
async function readBodyLimited(req: Request, maxBytes: number): Promise<string> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ApiError("payload_too_large", `Request body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function parseQuery<T extends z.ZodType>(url: string, schema: T): z.infer<T> {
  const params = Object.fromEntries(new URL(url).searchParams.entries());
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError(
      "bad_request",
      "Invalid query parameters.",
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return parsed.data;
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "local";
}

/** NDJSON streaming helper used by search and chat. */
export function ndjsonStream(
  run: (send: (event: Record<string, unknown>) => void, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          /* stream already closed */
        }
      };
      try {
        await run(send, signal);
      } catch (err) {
        const e = err instanceof ApiError ? err : null;
        if (!e) reportError(err);
        send({
          type: "error",
          code: e?.code ?? "internal",
          message: e?.message ?? "The request failed unexpectedly.",
        });
      } finally {
        try {
          controller.close();
        } catch {
          /* noop */
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Path ids are UUIDs; anything else is simply not found (not a database error). */
export function requireUuid(id: string): string {
  if (!UUID.test(id)) throw new ApiError("not_found", "Not found.");
  return id;
}
