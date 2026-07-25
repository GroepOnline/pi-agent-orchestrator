import { Link } from "react-router";

import { TerminalShowcase } from "@/components/terminal-showcase";
import { ShowcaseMediaCard } from "@/components/showcase-media-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { showcaseMedia, showcasePipelines } from "@/lib/content";

export function ShowcasePage() {
  const featured = showcaseMedia.filter((item) => item.featured);
  const byPipeline = Object.fromEntries(
    showcasePipelines.map((pipeline) => [
      pipeline.id,
      showcaseMedia.filter((item) => item.pipeline === pipeline.id && !item.featured),
    ]),
  ) as Record<string, typeof showcaseMedia>;

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-16 md:py-20">
      <div className="flex flex-col gap-4">
        <Badge variant="outline" className="w-fit border-accent/40 text-accent">
          Showcase
        </Badge>
        <h1 className="text-4xl font-semibold tracking-tight md:text-5xl">Terminal media gallery</h1>
        <p className="max-w-3xl text-lg text-muted-foreground">
          Real dashboard captures — not mockups. Remotion composes hero video, feature tours, and promo
          stills from repository metadata; programmatic, tmux, live, and VHS pipelines cover CI and
          editorial workflows.
        </p>
      </div>

      <Separator className="my-10" />

      <section className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h2 className="text-3xl font-semibold tracking-tight">Hero terminal capture</h2>
          <p className="max-w-2xl text-muted-foreground">
            Frames come from the compiled dashboard implementation; Remotion supplies window chrome and
            encode. Regenerate with <code className="rounded bg-secondary px-1.5 py-0.5 text-sm">npm run showcase:remotion</code>.
          </p>
        </div>
        <TerminalShowcase />
      </section>

      <Separator className="my-10" />

      <section className="flex flex-col gap-6">
        <h2 className="text-3xl font-semibold tracking-tight">Remotion promo suite</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {featured.map((item) => (
            <ShowcaseMediaCard key={item.id} item={item} />
          ))}
        </div>
      </section>

      <Separator className="my-10" />

      <Tabs defaultValue="pipelines" className="flex flex-col gap-8">
        <TabsList>
          <TabsTrigger value="pipelines">Pipelines</TabsTrigger>
          {showcasePipelines.map((pipeline) => (
            <TabsTrigger key={pipeline.id} value={pipeline.id}>
              {pipeline.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="pipelines">
          <div className="grid gap-4 md:grid-cols-2">
            {showcasePipelines.map((pipeline) => (
              <Card key={pipeline.id} className="border-border/80 bg-card/80">
                <CardHeader className="gap-3">
                  <CardTitle>{pipeline.label}</CardTitle>
                  <CardDescription>{pipeline.summary}</CardDescription>
                </CardHeader>
                <CardContent>
                  <pre className="overflow-x-auto rounded-lg border border-border/80 bg-[#080a0d] p-4 font-mono text-sm text-[#dfe4e8]">
                    {pipeline.command}
                  </pre>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        {showcasePipelines.map((pipeline) => (
          <TabsContent key={pipeline.id} value={pipeline.id}>
            <div className="grid gap-4 md:grid-cols-2">
              {byPipeline[pipeline.id]?.map((item) => (
                <ShowcaseMediaCard key={item.id} item={item} />
              ))}
            </div>
          </TabsContent>
        ))}
      </Tabs>

      <Separator className="my-10" />

      <section className="rounded-xl border border-border/80 bg-secondary/20 px-6 py-5 text-sm text-muted-foreground">
        <p>
          Full pipeline docs live in the repository showcase skill. CI renders Remotion on{" "}
          <code className="rounded bg-secondary px-1.5 py-0.5">main</code> via the Showcase workflow;
          optional assets appear here automatically after the next render.
        </p>
        <p className="mt-3">
          <Link to="/install" className="text-accent underline">
            Install the package
          </Link>{" "}
          or{" "}
          <Link to="/docs" className="text-accent underline">
            browse documentation
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
