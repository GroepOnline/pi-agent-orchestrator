# Pi Agent Orchestrator

> A Pi extension for autonomous sub-agents, structured handoffs, recurring schedules, swarms, prompt compression, and a responsive terminal dashboard.

Pi Agent Orchestrator runs inside the Pi coding-agent host. It adds a bounded control plane for spawning specialized agents, partitioning work, coordinating swarms, transferring structured handoffs, scheduling recurring jobs, and observing the fleet from a vim-style TUI.

## Terminal showcase

The showcase video is generated from the compiled dashboard, resource top-view, and widget renderers. Remotion frames and encodes the video, but the terminal content comes from the real implementation.

- [Watch the MP4 terminal showcase](./assets/dashboard_preview.mp4)
- [Open the poster image](./assets/dashboard_preview.gif)

## Install

```bash
pi install npm:@groeponline/pi-agent-orchestrator
```

Open a Pi session and run:

```text
/agents
```

## Main capabilities

- Specialized built-in and custom sub-agents with permission inheritance.
- JSON-based structured handoffs between agents.
- Dynamic swarm coordination and bounded parallel execution.
- Persistent recurring schedules and daemon visibility.
- Minimal, balanced, and aggressive prompt-compression policies.
- Responsive TUI views for the agent list, resource top, schedules, performance, help, and settings.

## Documentation

- [README](./README.md)
- [Architecture](./docs/architecture.md)
- [API reference](./docs/api-reference.md)
- [Coding-agent guide](./AGENTS.md)
- [Compact LLM index](./llms.txt)
- [Expanded LLM context](./llms-full.txt)
