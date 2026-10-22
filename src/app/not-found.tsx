import Link from "next/link";
import { ChipMascot } from "@/components/brand/chip";
import { Logo } from "@/components/layout/logo";

export default function NotFound() {
  return (
    <div className="orbis-glow grid min-h-dvh place-items-center px-4 text-center">
      <div>
        <Logo className="justify-center" />
        <ChipMascot mood="oops" className="mx-auto mt-10 h-24 w-24" />
        <h1 className="mt-6 text-2xl font-semibold">Page not found</h1>
        <p className="mt-2 text-sm text-muted">It may have been moved, deleted, or never existed.</p>
        <Link href="/" className="mt-6 inline-block rounded-xl bg-accent px-4 py-2 text-sm font-medium text-accent-fg">Back home</Link>
      </div>
    </div>
  );
}
