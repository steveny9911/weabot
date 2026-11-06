import {
  buildMarker,
  commentOnIssue,
  ensureAgentLabels,
  setIssueStateLabel,
  viewIssue,
} from "./common.ts";

function usage(): never {
  throw new Error("Usage: bun run agent:mark-pr-open <issue_number> <pr_url>");
}

export async function runMarkPrOpen(
  cwd = process.cwd(),
  args = process.argv.slice(2),
): Promise<void> {
  if (args.length < 2) usage();
  const issueNumber = Number.parseInt(args[0], 10);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) usage();
  const prUrl = args[1].trim();
  if (!prUrl) usage();

  await ensureAgentLabels(cwd);
  const issue = await viewIssue(issueNumber, cwd);

  await setIssueStateLabel(issue, "agent:pr-open", cwd);
  await commentOnIssue(
    issue.number,
    [
      buildMarker("pr-open", "automation-pr"),
      `Automation opened a PR for this issue: ${prUrl}`,
    ].join("\n"),
    cwd,
  );

  console.log(`[ISSUE-AGENT] marked issue #${issueNumber} as pr-open`);
}

if (import.meta.main) {
  await runMarkPrOpen();
}
