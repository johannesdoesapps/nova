import Link from "next/link";
import { Notice } from "@/components/ui/primitives";

/** Shown when a feature runs in demo mode or a key is missing. Names the exact env var. */
export function SetupNotice({ envVars, feature, demo = true }: { envVars: string[]; feature: string; demo?: boolean }) {
  return (
    <Notice tone="warning" title={demo ? `${feature} is running in demo mode` : `${feature} needs configuration`}>
      Add {envVars.map((v, i) => (
        <span key={v}>
          {i > 0 ? (i === envVars.length - 1 ? " and " : ", ") : ""}
          <code>{v}</code>
        </span>
      ))}{" "}
      to <code>.env.local</code> and restart the server.{" "}
      {demo && "Until then, results are clearly labelled as simulated. "}
      <Link href="/settings" className="text-accent underline-offset-2 hover:underline">
        See setup status
      </Link>
    </Notice>
  );
}
