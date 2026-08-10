import { Separator } from "@/components/ui/separator";
import { CANONICAL_BASE_URL, PRODUCT_NAME } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-border/80">
      <Separator />
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-5 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <p>
          MIT licensed · GroepOnline · Built for the Pi coding-agent host.
        </p>
        <p className="font-mono text-xs">{CANONICAL_BASE_URL.replace("https://", "")}</p>
      </div>
      <span className="sr-only">{PRODUCT_NAME}</span>
    </footer>
  );
}
