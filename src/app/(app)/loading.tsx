import { Spinner } from "@/components/ui/primitives";

export default function Loading() {
  return (
    <div className="grid min-h-[60vh] place-items-center">
      <Spinner className="h-5 w-5" />
    </div>
  );
}
