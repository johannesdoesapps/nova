"use client";
import { Notice } from "@/components/ui/primitives";

/** Explains how to start the Python engine when it isn't reachable. */
export function EngineError({ message }: { message: string }) {
  const down = /not reachable|not configured/i.test(message);
  return (
    <Notice tone={down ? "warning" : "danger"} title={down ? "The Orbis engine isn't running" : "Something went wrong"}>
      {message}
      {down && (
        <span className="mt-2 block">
          Start it with <code>cd engine &amp;&amp; .venv/bin/python -m nova_engine</code> and set the same <code>NOVA_ENGINE_SECRET</code> in both <code>.env.local</code> and the engine&apos;s environment.
        </span>
      )}
    </Notice>
  );
}
