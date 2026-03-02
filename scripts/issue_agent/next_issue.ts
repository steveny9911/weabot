import {
  buildMarker,
  commentOnIssue,
  ensureAgentLabels,
  getStateLabels,
  issueHasLabel,
  listOpenIssues,
  setIssueStateLabel,
  type GhIssue,
} from "./common.ts";

function parseArgs(args: string[]): { claim: boolean } {
  return {
    claim: args.includes("--claim"),
  };
}

function pickIssue(issues: GhIssue[]): GhIssue | null {
  const accepted = issues
    .filter((issue) => issueHasLabel(issue, "agent:accepted"))
    .filter((issue) => !issueHasLabel(issue, "agent:in-progress"))
    .filter((issue) => !issueHasLabel(issue, "agent:pr-open"))
    .sort((a, b) => a.number - b.number);

  return accepted[0] ?? null;
}

export interface NextIssueResult {
  ok: boolean;
  found: boolean;
  reason?: string;
  issue?: {
    number: number;
    title: string;
    url: string;
  };
}

export async function runNextIssue(cwd = Deno.cwd(), args = Deno.args): Promise<NextIssueResult> {
  await ensureAgentLabels(cwd);
  const { claim } = parseArgs(args);
  const issues = await listOpenIssues(cwd);
  const picked = pickIssue(issues);

  if (!picked) {
    return { ok: true, found: false };
  }

  if (claim) {
    // Re-fetch labels right before claiming to reduce race risks.
    const refreshed = (await listOpenIssues(cwd)).find((x) => x.number === picked.number);
    if (!refreshed) {
      return { ok: false, found: false, reason: "issue-not-found" };
    }

    const state_labels = getStateLabels(refreshed);
    if (state_labels.some((label) => label === "agent:in-progress" || label === "agent:pr-open")) {
      return { ok: true, found: false, reason: "already-claimed" };
    }

    await setIssueStateLabel(refreshed, "agent:in-progress", cwd);
    await commentOnIssue(
      refreshed.number,
      [
        buildMarker("in-progress", "claimed"),
        "Haru automation has claimed this issue for implementation.",
      ].join("\n"),
      cwd,
    );
  }

  const output = {
    ok: true,
    found: true,
    issue: {
      number: picked.number,
      title: picked.title,
      url: picked.url,
    },
  };
  return output;
}

if (import.meta.main) {
  const result = await runNextIssue();
  console.log(JSON.stringify(result));
}
