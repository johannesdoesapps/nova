"use client";
import { useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * Makes ORBIS_CONNECTOR_KEY for the administrator: 32 random bytes from the
 * browser's own cryptographic generator, shown once to copy into Vercel.
 * It is never sent to Orbis or stored anywhere by this page.
 */
export function KeyGenerator() {
  const [key, setKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const make = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    setKey(btoa(String.fromCharCode(...bytes)));
    setCopied(false);
  };
  return (
    <div className="mt-3">
      {!key ? (
        <button type="button" onClick={make} className="h-9 rounded-full bg-s-accent px-4 text-[13px] font-medium text-s-accent-ink">
          Generate a key
        </button>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-s-line bg-s-hover px-2.5 py-2 font-mono text-[12.5px]">{key}</code>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(key).then(() => setCopied(true))}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px]"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-[12.5px] text-s-ink-2">
            <li>In Vercel, open the orbis project → Settings → Environment Variables.</li>
            <li>
              Add <code className="font-mono">ORBIS_CONNECTOR_KEY</code> with this value, for Production, and tick <strong>Sensitive</strong>.
            </li>
            <li>Redeploy. Keep the key private and don&apos;t change it later: connections saved with it would stop working.</li>
          </ol>
        </div>
      )}
    </div>
  );
}
