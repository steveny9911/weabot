import {
  buildMarker,
  commentOnIssue,
  ensureAgentLabels,
  setIssueStateLabel,
  viewIssue,
} from "./common.ts";

function usage(): never {
  throw new Error(
    "Usage: deno run ... scripts/issue_agent/mark_pr_open.ts <issue_number> <pr_url>",
  );
}

export async function runMarkPrOpen(cwd = Deno.cwd(), args = Deno.args): Promise<void> {
  if (args.length < 2) usage();
  const issue_number = Number.parseInt(args[0], 10);
  if (!Number.isInteger(issue_number) || issue_number <= 0) usage();
  const pr_url = args[1].trim();
  if (!pr_url) usage();

  await ensureAgentLabels(cwd);
  const issue = await viewIssue(issue_number, cwd);

  await setIssueStateLabel(issue, "agent:pr-open", cwd);
  await commentOnIssue(
    issue.number,
    [
      buildMarker("pr-open", "automation-pr"),
      `Automation opened a PR for this issue: ${pr_url}`,
    ].join("\n"),
    cwd,
  );

  console.log(`[ISSUE-AGENT] marked issue #${issue_number} as pr-open`);
}

if (import.meta.main) {
  await runMarkPrOpen();
}
