import { Link, Navigate, useParams } from "react-router";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { docSources } from "@/lib/doc-sources";
import { NPM_PACKAGE } from "@/lib/site";

export function DocViewPage() {
  const { docId } = useParams<{ docId: string }>();
  const doc = docId ? docSources[docId] : undefined;

  if (!doc) {
    return <Navigate to="/docs" replace />;
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-5 py-16 md:py-20">
      <div className="flex flex-col gap-4">
        <Button asChild variant="ghost" size="sm" className="w-fit px-0 text-muted-foreground">
          <Link to="/docs">← Documentation index</Link>
        </Button>
        <Badge variant="outline" className="w-fit border-accent/40 text-accent">
          Documentation
        </Badge>
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">{doc.title}</h1>
        <p className="text-sm text-muted-foreground">
          Rendered for humans on the web. Agents should read the raw markdown from the installed
          package (<code className="rounded bg-secondary px-1.5 py-0.5">{NPM_PACKAGE}</code>
          {" "}
          → <code className="rounded bg-secondary px-1.5 py-0.5">docs/</code>).
        </p>
      </div>

      <Separator className="my-8" />

      <article className="doc-prose text-foreground">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.markdown}</ReactMarkdown>
      </article>
    </div>
  );
}
