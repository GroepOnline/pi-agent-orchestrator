import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_PARENT_ISSUE = "CHEF-31";
const LINEAR_REQUEST_TIMEOUT_MS = 15_000;
const MAX_CHILD_PAGES = 100;

const PARENT_QUERY = [
  "query ParentIssue($id: String!, $cursor: String) {",
  "  issue(id: $id) {",
  "    id",
  "    project { id }",
  "    team {",
  "      id",
  "      states { nodes { id name type } }",
  "    }",
  "    children(first: 100, after: $cursor) {",
  "      nodes { id identifier description }",
  "      pageInfo { hasNextPage endCursor }",
  "    }",
  "  }",
  "}",
].join("\n");

const CREATE_ISSUE = [
  "mutation CreateIssue($input: IssueCreateInput!) {",
  "  issueCreate(input: $input) {",
  "    success",
  "    issue { id identifier url }",
  "  }",
  "}",
].join("\n");

const UPDATE_ISSUE = [
  "mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {",
  "  issueUpdate(id: $id, input: $input) {",
  "    success",
  "    issue { id identifier url }",
  "  }",
  "}",
].join("\n");

export function githubMarker(repository, kind, number) {
  return `<!-- github-${kind}:${repository}#${number} -->`;
}

function labelNames(labels = []) {
  return labels
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter(Boolean);
}

export function normalizeGithubEntity(event, repository) {
  if (event.pull_request) {
    const pullRequest = event.pull_request;
    const merged = Boolean(pullRequest.merged || pullRequest.merged_at);
    const stateKey = merged
      ? "done"
      : pullRequest.state === "closed"
        ? "canceled"
        : pullRequest.draft
          ? "in-progress"
          : "in-review";

    return {
      kind: "pr",
      number: pullRequest.number,
      title: `PR #${pullRequest.number}: ${pullRequest.title}`,
      url: pullRequest.html_url,
      author: pullRequest.user?.login ?? "unknown",
      body: pullRequest.body ?? "",
      labels: labelNames(pullRequest.labels),
      stateKey,
      status: merged ? "merged" : pullRequest.state,
      branch: pullRequest.head?.ref ?? "unknown",
      marker: githubMarker(repository, "pr", pullRequest.number),
      updatedAt: pullRequest.updated_at ?? new Date().toISOString(),
    };
  }

  if (event.issue) {
    const issue = event.issue;
    const stateKey =
      issue.state === "closed"
        ? issue.state_reason === "not_planned"
          ? "canceled"
          : "done"
        : "backlog";

    return {
      kind: "issue",
      number: issue.number,
      title: `GitHub issue #${issue.number}: ${issue.title}`,
      url: issue.html_url,
      author: issue.user?.login ?? "unknown",
      body: issue.body ?? "",
      labels: labelNames(issue.labels),
      stateKey,
      status: issue.state,
      branch: null,
      marker: githubMarker(repository, "issue", issue.number),
      updatedAt: issue.updated_at ?? new Date().toISOString(),
    };
  }

  throw new Error("Unsupported GitHub event: expected pull_request or issue payload");
}

export function selectLinearState(states, stateKey) {
  const preferredNames = {
    backlog: ["Backlog", "Triage", "Todo"],
    "in-progress": ["In Progress", "Started"],
    "in-review": ["In Review", "Review"],
    done: ["Done", "Completed"],
    canceled: ["Canceled", "Cancelled"],
  };
  const preferredTypes = {
    backlog: ["backlog", "unstarted"],
    "in-progress": ["started"],
    "in-review": [],
    done: ["completed"],
    canceled: ["canceled", "cancelled"],
  };

  for (const name of preferredNames[stateKey] ?? []) {
    const match = states.find((state) => state.name.toLowerCase() === name.toLowerCase());
    if (match) return match;
  }

  for (const type of preferredTypes[stateKey] ?? []) {
    const matches = states.filter((state) => state.type.toLowerCase() === type);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`Ambiguous Linear workflow state for ${stateKey}: ${type}`);
    }
  }

  throw new Error(`No unambiguous Linear workflow state found for ${stateKey}`);
}

export function buildLinearDescription(entity, repository) {
  const labels = entity.labels.length > 0 ? entity.labels.join(", ") : "none";
  const branch = entity.branch ? `\n- Branch: \`${entity.branch}\`` : "";
  const body = entity.body.trim().slice(0, 8000) || "_No description provided._";

  return `${entity.marker}
Auto-synced from [${repository} ${entity.kind} #${entity.number}](${entity.url}).

- GitHub status: **${entity.status}**
- Author: \`${entity.author}\`
- Labels: ${labels}${branch}
- Last GitHub update: ${entity.updatedAt}

## GitHub description

${body}`;
}

async function linearRequest(token, query, variables, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(LINEAR_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(LINEAR_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new Error(`Linear API request timed out after ${LINEAR_REQUEST_TIMEOUT_MS}ms`, {
        cause: error,
      });
    }
    throw error;
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`Linear API returned invalid JSON (${response.status})`, { cause: error });
  }

  if (!response.ok || payload.errors) {
    throw new Error(
      `Linear API request failed (${response.status}): ${JSON.stringify(payload.errors ?? payload)}`,
    );
  }
  return payload.data;
}

async function loadParentAndExisting({ token, parentIssue, marker, fetchImpl }) {
  let cursor = null;
  let parent = null;

  for (let page = 0; page < MAX_CHILD_PAGES; page++) {
    const parentData = await linearRequest(
      token,
      PARENT_QUERY,
      { id: parentIssue, cursor },
      fetchImpl,
    );
    const currentParent = parentData.issue;
    if (!currentParent) throw new Error(`Linear parent issue not found: ${parentIssue}`);
    parent ??= currentParent;

    const existing = currentParent.children.nodes.find((child) =>
      child.description?.includes(marker),
    );
    if (existing) return { parent, existing };

    const pageInfo = currentParent.children.pageInfo;
    if (!pageInfo.hasNextPage) return { parent, existing: null };
    if (!pageInfo.endCursor) {
      throw new Error(`Linear child pagination returned no cursor for ${parentIssue}`);
    }
    cursor = pageInfo.endCursor;
  }

  throw new Error(`Linear child pagination exceeded ${MAX_CHILD_PAGES} pages for ${parentIssue}`);
}

function requireMutationIssue(payload, mutationName, marker, parentIssue) {
  if (payload?.success === true && payload.issue) return payload.issue;
  throw new Error(
    `Linear ${mutationName} failed for ${marker} under ${parentIssue}: missing successful issue payload`,
  );
}

export async function syncGithubEvent({
  event,
  repository,
  token,
  parentIssue = DEFAULT_PARENT_ISSUE,
  fetchImpl = fetch,
}) {
  const entity = normalizeGithubEntity(event, repository);
  const { parent, existing } = await loadParentAndExisting({
    token,
    parentIssue,
    marker: entity.marker,
    fetchImpl,
  });

  const state = selectLinearState(parent.team.states.nodes, entity.stateKey);
  const description = buildLinearDescription(entity, repository);

  if (existing) {
    const data = await linearRequest(
      token,
      UPDATE_ISSUE,
      {
        id: existing.id,
        input: {
          title: entity.title,
          description,
          stateId: state.id,
        },
      },
      fetchImpl,
    );
    return {
      action: "updated",
      issue: requireMutationIssue(data.issueUpdate, "update", entity.marker, parentIssue),
    };
  }

  const input = {
    teamId: parent.team.id,
    parentId: parent.id,
    stateId: state.id,
    title: entity.title,
    description,
    priority: 3,
  };
  if (parent.project?.id) input.projectId = parent.project.id;

  const data = await linearRequest(token, CREATE_ISSUE, { input }, fetchImpl);
  return {
    action: "created",
    issue: requireMutationIssue(data.issueCreate, "create", entity.marker, parentIssue),
  };
}

async function main() {
  const token = process.env.LINEAR_API_KEY;
  if (!token) {
    console.log("::warning::Linear sync skipped because LINEAR_API_KEY is not configured");
    return;
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!eventPath || !repository) {
    throw new Error("GITHUB_EVENT_PATH and GITHUB_REPOSITORY are required");
  }

  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const result = await syncGithubEvent({
    event,
    repository,
    token,
    parentIssue: process.env.LINEAR_PARENT_ISSUE || DEFAULT_PARENT_ISSUE,
  });

  console.log(`${result.action} Linear issue ${result.issue.identifier}: ${result.issue.url}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = String(error?.message ?? error);
    // After org transfer, LINEAR_PARENT_ISSUE may still point at a missing
    // CHEF-* parent. Soft-skip so release cutover PRs are not blocked.
    if (
      message.includes("Entity not found: Issue") ||
      message.includes("Linear parent issue not found:")
    ) {
      console.log(`::warning::Linear sync skipped: ${message}`);
      return;
    }
    console.error(error);
    process.exitCode = 1;
  });
}
