import { describe, expect, it, vi } from "vitest";
import {
  buildLinearDescription,
  githubMarker,
  normalizeGithubEntity,
  selectLinearState,
  syncGithubEvent,
} from "../scripts/linear-github-sync.mjs";

const repository = "GroepOnline/pi-agent-orchestrator";

const workflowStates = [
  { id: "backlog", name: "Backlog", type: "backlog" },
  { id: "progress", name: "In Progress", type: "started" },
  { id: "review", name: "In Review", type: "started" },
  { id: "done", name: "Done", type: "completed" },
  { id: "canceled", name: "Canceled", type: "canceled" },
];

function issueEvent(number = 44) {
  return {
    issue: {
      number,
      title: "Contributor task",
      html_url: `https://example.test/issues/${number}`,
      state: "open",
      state_reason: null,
      body: "Task body",
      user: { login: "contributor" },
      labels: [{ name: "good first issue" }],
      updated_at: "2026-07-12T00:00:00Z",
    },
  };
}

function parentPayload({
  children = [],
  hasNextPage = false,
  endCursor = null,
} = {}) {
  return {
    data: {
      issue: {
        id: "parent-id",
        project: { id: "project-id" },
        team: { id: "team-id", states: { nodes: workflowStates } },
        children: {
          nodes: children,
          pageInfo: { hasNextPage, endCursor },
        },
      },
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseRequest(init?: RequestInit) {
  if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
  return JSON.parse(init.body);
}

describe("linear GitHub sync mapping", () => {
  it("maps a ready pull request to Linear review state", () => {
    const entity = normalizeGithubEntity(
      {
        pull_request: {
          number: 253,
          title: "Add validator coverage",
          html_url: "https://github.com/GroepOnline/pi-agent-orchestrator/pull/253",
          state: "open",
          draft: false,
          merged: false,
          body: "Coverage for validator paths.",
          user: { login: "contributor" },
          labels: [{ name: "area: tests" }],
          head: { ref: "test/validator" },
          updated_at: "2026-07-12T00:00:00Z",
        },
      },
      repository,
    );

    expect(entity.stateKey).toBe("in-review");
    expect(entity.marker).toBe(
      "<!-- github-pr:GroepOnline/pi-agent-orchestrator#253 -->",
    );
    expect(entity.labels).toEqual(["area: tests"]);
  });

  it("maps draft, merged, and closed pull requests to distinct states", () => {
    const base = {
      number: 12,
      title: "Example",
      html_url: "https://example.test/pr/12",
      body: "",
      user: { login: "contributor" },
      labels: [],
      head: { ref: "example" },
      updated_at: "2026-07-12T00:00:00Z",
    };

    expect(
      normalizeGithubEntity(
        { pull_request: { ...base, state: "open", draft: true, merged: false } },
        repository,
      ).stateKey,
    ).toBe("in-progress");
    expect(
      normalizeGithubEntity(
        { pull_request: { ...base, state: "closed", draft: false, merged: true } },
        repository,
      ).stateKey,
    ).toBe("done");
    expect(
      normalizeGithubEntity(
        { pull_request: { ...base, state: "closed", draft: false, merged: false } },
        repository,
      ).stateKey,
    ).toBe("canceled");
  });

  it("maps GitHub issues to backlog, done, or canceled", () => {
    const base = issueEvent().issue;

    expect(
      normalizeGithubEntity({ issue: { ...base, state: "open" } }, repository).stateKey,
    ).toBe("backlog");
    expect(
      normalizeGithubEntity(
        { issue: { ...base, state: "closed", state_reason: "completed" } },
        repository,
      ).stateKey,
    ).toBe("done");
    expect(
      normalizeGithubEntity(
        { issue: { ...base, state: "closed", state_reason: "not_planned" } },
        repository,
      ).stateKey,
    ).toBe("canceled");
  });

  it("uses exact review names and unambiguous type fallbacks", () => {
    const fallbackStates = [
      { id: "1", name: "Queue", type: "backlog" },
      { id: "2", name: "Active", type: "started" },
      { id: "3", name: "Review", type: "started" },
      { id: "4", name: "Shipped", type: "completed" },
      { id: "5", name: "Abandoned", type: "canceled" },
    ];

    expect(selectLinearState(fallbackStates, "backlog").id).toBe("1");
    expect(selectLinearState(fallbackStates, "in-review").id).toBe("3");
    expect(selectLinearState(fallbackStates, "done").id).toBe("4");
    expect(selectLinearState(fallbackStates, "canceled").id).toBe("5");
  });

  it("rejects ambiguous or missing started-state fallbacks", () => {
    expect(() =>
      selectLinearState(
        [
          { id: "1", name: "Active A", type: "started" },
          { id: "2", name: "Active B", type: "started" },
        ],
        "in-progress",
      ),
    ).toThrow("Ambiguous Linear workflow state");

    expect(() =>
      selectLinearState([{ id: "1", name: "Active", type: "started" }], "in-review"),
    ).toThrow("No unambiguous Linear workflow state");
  });

  it("builds an idempotency marker and preserves source metadata", () => {
    const marker = githubMarker(repository, "issue", 44);
    const description = buildLinearDescription(
      {
        kind: "issue",
        number: 44,
        title: "GitHub issue #44: Example",
        url: "https://example.test/issues/44",
        author: "contributor",
        body: "Useful task details",
        labels: ["good first issue", "help wanted"],
        stateKey: "backlog",
        status: "open",
        branch: null,
        marker,
        updatedAt: "2026-07-12T00:00:00Z",
      },
      repository,
    );

    expect(description).toContain(marker);
    expect(description).toContain("good first issue, help wanted");
    expect(description).toContain("Useful task details");
  });
});

describe("syncGithubEvent", () => {
  it("updates an existing marker-matched Linear child", async () => {
    const marker = githubMarker(repository, "issue", 44);
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = parseRequest(init);
      requests.push(request);
      if (request.query.includes("query ParentIssue")) {
        return jsonResponse(
          parentPayload({
            children: [{ id: "existing-id", identifier: "CHEF-700", description: marker }],
          }),
        );
      }
      if (request.query.includes("mutation UpdateIssue")) {
        return jsonResponse({
          data: {
            issueUpdate: {
              success: true,
              issue: { id: "existing-id", identifier: "CHEF-700", url: "https://linear.test/700" },
            },
          },
        });
      }
      throw new Error("Unexpected GraphQL operation");
    });

    const result = await syncGithubEvent({
      event: issueEvent(),
      repository,
      token: "token",
      parentIssue: "CHEF-31",
      fetchImpl,
    });

    expect(result.action).toBe("updated");
    expect(result.issue.identifier).toBe("CHEF-700");
    expect(requests).toHaveLength(2);
    expect(requests[1].variables.id).toBe("existing-id");
  });

  it("creates a child when no marker exists", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = parseRequest(init);
      if (request.query.includes("query ParentIssue")) {
        return jsonResponse(parentPayload());
      }
      if (request.query.includes("mutation CreateIssue")) {
        expect(request.variables.input.parentId).toBe("parent-id");
        expect(request.variables.input.projectId).toBe("project-id");
        return jsonResponse({
          data: {
            issueCreate: {
              success: true,
              issue: { id: "new-id", identifier: "CHEF-701", url: "https://linear.test/701" },
            },
          },
        });
      }
      throw new Error("Unexpected GraphQL operation");
    });

    const result = await syncGithubEvent({
      event: issueEvent(45),
      repository,
      token: "token",
      parentIssue: "CHEF-31",
      fetchImpl,
    });

    expect(result.action).toBe("created");
    expect(result.issue.identifier).toBe("CHEF-701");
  });

  it("paginates Linear children before deciding to create", async () => {
    const marker = githubMarker(repository, "issue", 44);
    const cursors: unknown[] = [];
    let parentCalls = 0;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = parseRequest(init);
      if (request.query.includes("query ParentIssue")) {
        cursors.push(request.variables.cursor);
        parentCalls++;
        return jsonResponse(
          parentCalls === 1
            ? parentPayload({ hasNextPage: true, endCursor: "cursor-1" })
            : parentPayload({
                children: [{ id: "existing-id", identifier: "CHEF-700", description: marker }],
              }),
        );
      }
      return jsonResponse({
        data: {
          issueUpdate: {
            success: true,
            issue: { id: "existing-id", identifier: "CHEF-700", url: "https://linear.test/700" },
          },
        },
      });
    });

    const result = await syncGithubEvent({
      event: issueEvent(),
      repository,
      token: "token",
      parentIssue: "CHEF-31",
      fetchImpl,
    });

    expect(result.action).toBe("updated");
    expect(cursors).toEqual([null, "cursor-1"]);
  });

  it("propagates Linear transport failures", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "unavailable" }, 503));

    await expect(
      syncGithubEvent({
        event: issueEvent(),
        repository,
        token: "token",
        parentIssue: "CHEF-31",
        fetchImpl,
      }),
    ).rejects.toThrow("Linear API request failed (503)");
  });

  it("rejects unsuccessful mutation payloads", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = parseRequest(init);
      if (request.query.includes("query ParentIssue")) {
        return jsonResponse(parentPayload());
      }
      return jsonResponse({ data: { issueCreate: { success: false, issue: null } } });
    });

    await expect(
      syncGithubEvent({
        event: issueEvent(),
        repository,
        token: "token",
        parentIssue: "CHEF-31",
        fetchImpl,
      }),
    ).rejects.toThrow("Linear create failed");
  });
});
