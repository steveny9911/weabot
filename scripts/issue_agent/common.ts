export type AgentDecision =
  | "accepted"
  | "needs-info"
  | "rejected"
  | "in-progress"
  | "pr-open"
  | "closed-inactive";

export interface GhLabel {
  name: string;
}

export interface GhUser {
  login: string;
}

export interface GhComment {
  id: string | number;
  body: string;
  createdAt: string;
  updatedAt?: string;
  author?: GhUser;
  url?: string;
}

export interface GhIssue {
  number: number;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  state?: string;
  author?: GhUser;
  labels: GhLabel[];
  comments?: GhComment[];
}

export interface AgentDecisionMarker {
  decision: AgentDecision;
  reason?: string;
  at: string;
  commentId?: string | number;
  commentUrl?: string;
}

export const AGENT_MARKER_PREFIX = "haru-issue-agent:v1";

export const STATE_LABELS = [
  "agent:accepted",
  "agent:needs-info",
  "agent:rejected",
  "agent:in-progress",
  "agent:pr-open",
  "agent:closed-inactive",
] as const;

export const STATE_LABEL_META: Record<(typeof STATE_LABELS)[number], { color: string; description: string }> = {
  "agent:accepted": {
    color: "0E8A16",
    description: "Accepted by automation for implementation",
  },
  "agent:needs-info": {
    color: "FBCA04",
    description: "Needs more details before automation can proceed",
  },
  "agent:rejected": {
    color: "B60205",
    description: "Rejected by automation (policy/scope/safety)",
  },
  "agent:in-progress": {
    color: "1D76DB",
    description: "Currently being implemented by automation",
  },
  "agent:pr-open": {
    color: "5319E7",
    description: "Automation opened a PR linked to this issue",
  },
  "agent:closed-inactive": {
    color: "6E7781",
    description: "Closed automatically due to inactivity",
  },
};

export function issueHasLabel(issue: GhIssue, label: string): boolean {
  return issue.labels.some((l) => l.name === label);
}

export function getStateLabels(issue: GhIssue): string[] {
  return issue.labels
    .map((l) => l.name)
    .filter((name) => STATE_LABELS.includes(name as (typeof STATE_LABELS)[number]));
}

function normalizeStdout(raw: Uint8Array): string {
  return new TextDecoder().decode(raw).trim();
}

export async function runGh(args: string[], cwd?: string): Promise<string> {
  const command = new Deno.Command("gh", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  const stdout = normalizeStdout(result.stdout);
  const stderr = normalizeStdout(result.stderr);
  if (result.code !== 0) {
    throw new Error(`gh ${args.join(" ")} failed (${result.code}): ${stderr || stdout}`);
  }
  return stdout;
}

export async function runGhJson<T>(args: string[], cwd?: string): Promise<T> {
  const out = await runGh(args, cwd);
  if (!out) {
    return [] as T;
  }
  return JSON.parse(out) as T;
}

export async function getRepoNameWithOwner(cwd?: string): Promise<string> {
  return await runGh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], cwd);
}

export async function getCurrentGhLogin(cwd?: string): Promise<string> {
  return await runGh(["api", "user", "-q", ".login"], cwd);
}

export async function ensureAgentLabels(cwd?: string): Promise<void> {
  for (const label of STATE_LABELS) {
    const meta = STATE_LABEL_META[label];
    await runGh(
      [
        "label",
        "create",
        label,
        "--color",
        meta.color,
        "--description",
        meta.description,
        "--force",
      ],
      cwd,
    );
  }
}

export async function listOpenIssues(cwd?: string): Promise<GhIssue[]> {
  const issues = await runGhJson<GhIssue[]>(
    [
      "issue",
      "list",
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,body,createdAt,updatedAt,url,author,labels",
    ],
    cwd,
  );
  return issues;
}

export async function viewIssue(issueNumber: number, cwd?: string): Promise<GhIssue> {
  return await runGhJson<GhIssue>(
    [
      "issue",
      "view",
      String(issueNumber),
      "--json",
      "number,title,body,createdAt,updatedAt,url,state,author,labels,comments",
    ],
    cwd,
  );
}

export function parseDecisionMarker(body: string): AgentDecisionMarker | null {
  const marker_re =
    /<!--\s*haru-issue-agent:v1\s+decision=([a-z-]+)(?:\s+reason=([a-z0-9_-]+))?(?:\s+at=([0-9TZ:.\-]+))?\s*-->/i;
  const match = body.match(marker_re);
  if (!match) return null;

  const raw_decision = match[1].toLowerCase();
  if (![
    "accepted",
    "needs-info",
    "rejected",
    "in-progress",
    "pr-open",
    "closed-inactive",
  ].includes(raw_decision)) {
    return null;
  }

  return {
    decision: raw_decision as AgentDecision,
    reason: match[2],
    at: match[3] ?? "",
  };
}

export function findLatestDecisionComment(
  issue: GhIssue,
  actorLogin: string,
): AgentDecisionMarker | null {
  const comments = issue.comments ?? [];
  const by_newest = [...comments].sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  for (const comment of by_newest) {
    const body = comment.body ?? "";
    if (!body.includes(AGENT_MARKER_PREFIX)) continue;
    const author = comment.author?.login ?? "";
    if (author.toLowerCase() !== actorLogin.toLowerCase()) continue;

    const parsed = parseDecisionMarker(body);
    if (!parsed) continue;
    const effective_at = parsed.at || comment.createdAt;
    return {
      ...parsed,
      at: effective_at,
      commentId: comment.id,
      commentUrl: comment.url,
    };
  }

  return null;
}

export async function commentOnIssue(
  issueNumber: number,
  body: string,
  cwd?: string,
): Promise<void> {
  await runGh(["issue", "comment", String(issueNumber), "--body", body], cwd);
}

export async function closeIssueWithComment(
  issueNumber: number,
  body: string,
  cwd?: string,
): Promise<void> {
  await runGh(["issue", "close", String(issueNumber), "--comment", body], cwd);
}

function asIsoNow(): string {
  return new Date().toISOString();
}

export function buildMarker(decision: AgentDecision, reason?: string): string {
  const reason_fragment = reason ? ` reason=${reason}` : "";
  return `<!-- ${AGENT_MARKER_PREFIX} decision=${decision}${reason_fragment} at=${asIsoNow()} -->`;
}

export async function setIssueStateLabel(
  issue: GhIssue,
  targetLabel: (typeof STATE_LABELS)[number],
  cwd?: string,
): Promise<void> {
  const existing_states = getStateLabels(issue);
  const to_remove = existing_states.filter((l) => l !== targetLabel);

  const args = ["issue", "edit", String(issue.number), "--add-label", targetLabel];
  for (const label of to_remove) {
    args.push("--remove-label", label);
  }

  await runGh(args, cwd);
}

export function issueUpdatedAfter(issueUpdatedAt: string, timestamp: string): boolean {
  const issue_ms = new Date(issueUpdatedAt).getTime();
  const marker_ms = new Date(timestamp).getTime();
  if (!Number.isFinite(issue_ms) || !Number.isFinite(marker_ms)) return true;
  return issue_ms > marker_ms + 30_000;
}

export function ageInMs(isoTimestamp: string): number {
  return Date.now() - new Date(isoTimestamp).getTime();
}
