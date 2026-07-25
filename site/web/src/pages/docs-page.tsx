import { Link } from "react-router";

import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { docLinks, type DocLink } from "@/lib/content";
import { NPM_PACKAGE } from "@/lib/site";

function DocGrid({ items }: { items: DocLink[] }) {
  return (
    <div className="grid gap-3">
      {items.map((doc) => (
        <Link
          key={doc.href}
          to={doc.href}
          className="group rounded-xl border border-border/80 bg-card/80 no-underline transition-colors hover:border-accent/40 hover:bg-card"
        >
          <Card className="border-0 bg-transparent shadow-none">
            <CardHeader className="gap-2">
              <div className="flex items-center justify-between gap-4">
                <CardTitle className="text-base group-hover:text-accent">{doc.title}</CardTitle>
                <span className="font-mono text-xs text-muted-foreground">HTML</span>
              </div>
              <CardDescription>{doc.description}</CardDescription>
            </CardHeader>
          </Card>
        </Link>
      ))}
    </div>
  );
}

export function DocsPage() {
  const coreDocs = docLinks.filter((doc) => doc.category === "core");
  const operationsDocs = docLinks.filter((doc) => doc.category === "operations");
  const repoDocs = docLinks.filter((doc) => doc.category === "repo");

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-16 md:py-20">
      <div className="flex flex-col gap-4">
        <Badge variant="outline" className="w-fit border-accent/40 text-accent">
          Documentation
        </Badge>
        <h1 className="text-4xl font-semibold tracking-tight md:text-5xl">Source-grounded documentation</h1>
        <p className="max-w-2xl text-lg text-muted-foreground">
          Human-readable HTML rendered from the same repository revision. Raw markdown ships with the
          npm package for agents — not as public site downloads.
        </p>
      </div>

      <Separator className="my-10" />

      <Card className="mb-10 border-border/80 bg-secondary/20">
        <CardHeader className="gap-2">
          <CardTitle className="text-base">For coding agents</CardTitle>
          <CardDescription>
            After <code className="rounded bg-secondary px-1.5 py-0.5 text-sm">pi install npm:{NPM_PACKAGE}</code>,
            read <code className="rounded bg-secondary px-1.5 py-0.5 text-sm">docs/*.md</code>,{" "}
            <code className="rounded bg-secondary px-1.5 py-0.5 text-sm">llms.txt</code>, and{" "}
            <code className="rounded bg-secondary px-1.5 py-0.5 text-sm">AGENTS.md</code> from the
            installed package root — not from this website.
          </CardDescription>
        </CardHeader>
      </Card>

      <Tabs defaultValue="core" className="flex flex-col gap-6">
        <TabsList>
          <TabsTrigger value="core">Core</TabsTrigger>
          <TabsTrigger value="operations">Operations</TabsTrigger>
          <TabsTrigger value="repo">Repository</TabsTrigger>
        </TabsList>

        <TabsContent value="core">
          <DocGrid items={coreDocs} />
        </TabsContent>
        <TabsContent value="operations">
          <DocGrid items={operationsDocs} />
        </TabsContent>
        <TabsContent value="repo">
          <DocGrid items={repoDocs} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
