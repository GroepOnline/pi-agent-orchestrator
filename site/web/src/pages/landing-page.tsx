import { Link } from "react-router";

import { TerminalShowcase } from "@/components/terminal-showcase";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { capabilities } from "@/lib/content";

export function LandingPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-16 md:py-24">
      <section className="flex flex-col gap-6">
        <Badge variant="outline" className="w-fit border-accent/40 text-accent">
          Pi extension · autonomous agent infrastructure
        </Badge>
        <h1 className="max-w-4xl text-4xl font-semibold tracking-tight text-foreground md:text-6xl md:leading-[1.02]">
          Run a coordinated agent fleet from one terminal.
        </h1>
        <p className="max-w-2xl text-lg text-muted-foreground md:text-xl">
          Spawn specialized agents, partition work, schedule recurring jobs, coordinate swarms,
          compress prompts, and inspect the full fleet through a responsive TUI.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link to="/install">Install package</Link>
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link to="/docs">Read documentation</Link>
          </Button>
          <Button asChild variant="secondary" size="lg">
            <Link to="/capabilities">View capabilities</Link>
          </Button>
          <Button asChild variant="ghost" size="lg">
            <Link to="/showcase">Watch showcase</Link>
          </Button>
        </div>
      </section>

      <Separator className="my-16" />

      <section className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">The actual terminal, not a mockup.</h2>
          <p className="max-w-2xl text-muted-foreground">
            The capture is generated from the compiled dashboard, top-view, and widget renderers.
            Remotion supplies the framing and final encode; the terminal frames come from the real
            implementation.
          </p>
        </div>
        <TerminalShowcase />
        <div>
          <Button asChild variant="outline">
            <Link to="/showcase">Full media gallery</Link>
          </Button>
        </div>
      </section>

      <Separator className="my-16" />

      <section className="flex flex-col gap-8">
        <div className="flex flex-col gap-3">
          <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">Orchestration primitives that compose.</h2>
          <p className="max-w-2xl text-muted-foreground">
            The extension stays inside the Pi host and adds the control-plane functions needed for
            bounded, observable multi-agent execution.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {capabilities.map((item) => (
            <Card key={item.title} className="border-border/80 bg-card/80">
              <CardHeader className="gap-3">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-lg">{item.title}</CardTitle>
                  {item.badge ? <Badge variant="secondary">{item.badge}</Badge> : null}
                </div>
                <CardDescription>{item.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
        <div>
          <Button asChild variant="outline">
            <Link to="/capabilities">Explore all capabilities</Link>
          </Button>
        </div>
      </section>

      <Separator className="my-16" />

      <section className="flex flex-col gap-6">
        <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">Install into an existing Pi environment.</h2>
        <p className="max-w-2xl text-muted-foreground">
          Requires a working Pi host with <code className="rounded bg-secondary px-1.5 py-0.5 text-sm">@earendil-works/pi-coding-agent</code>.
        </p>
        <Card className="border-border/80 bg-[#080a0d]">
          <CardContent className="overflow-x-auto p-6 font-mono text-sm leading-7 text-[#dfe4e8]">
            <pre className="m-0 whitespace-pre-wrap">{`pi install npm:@onlinechefgroep/pi-agent-orchestrator

# Open the dashboard inside Pi
/agents`}</pre>
          </CardContent>
        </Card>
        <Button asChild>
          <Link to="/install">Full install guide</Link>
        </Button>
      </section>
    </div>
  );
}
