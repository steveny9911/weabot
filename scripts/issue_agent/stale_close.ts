import {
  ageInMs,
  buildMarker,
  closeIssueWithComment,
  ensureAgentLabels,
  findLatestDecisionComment,
  getCurrentGhLogin,
  issueHasLabel,
  issueUpdatedAfter,
  listOpenIssues,
  setIssueStateLabel,
  viewIssue,
} from "./common.ts";

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

function formatCloseComment(): string {
  return [
    buildMarker("closed-inactive", "no-update-3d"),
    "Closing this issue due to inactivity.",
    "",
    "The issue was previously triaged as `needs-info` or `rejected` and has not received updates for 3 days.",
    "If you still want this worked on, add the missing details and re-open the issue.",
  ].join("\n");
}

export async function runStaleClose(cwd = Deno.cwd()): Promise<void> {
  await ensureAgentLabels(cwd);
  const actor = await getCurrentGhLogin(cwd);
  const issues = await listOpenIssues(cwd);

  let candidates = 0;
  let closed = 0;

  for (const summary of issues) {
    const is_stale_candidate = issueHasLabel(summary, "agent:needs-info") ||
      issueHasLabel(summary, "agent:rejected");
    if (!is_stale_candidate) continue;
    if (issueHasLabel(summary, "agent:pr-open") || issueHasLabel(summary, "agent:in-progress")) {
      continue;
    }

    const issue = await viewIssue(summary.number, cwd);
    const latest = findLatestDecisionComment(issue, actor);
    if (!latest) continue;
    if (latest.decision !== "needs-info" && latest.decision !== "rejected") continue;

    candidates++;
    if (issueUpdatedAfter(issue.updatedAt, latest.at)) {
      continue;
    }

    if (ageInMs(latest.at) < THREE_DAYS_MS) {
      continue;
    }

    await closeIssueWithComment(issue.number, formatCloseComment(), cwd);
    await setIssueStateLabel(issue, "agent:closed-inactive", cwd);
    closed++;
  }

  console.log(`[ISSUE-AGENT] stale-close complete candidates=${candidates} closed=${closed}`);
}

if (import.meta.main) {
  await runStaleClose();
}
