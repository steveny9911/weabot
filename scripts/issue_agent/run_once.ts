import { runStaleClose } from "./stale_close.ts";
import { runNextIssue } from "./next_issue.ts";
import { runTriage } from "./triage.ts";

export async function runOnce(cwd = Deno.cwd()): Promise<void> {
  console.log("[ISSUE-AGENT] run-once: triage");
  await runTriage(cwd);

  console.log("[ISSUE-AGENT] run-once: stale-close");
  await runStaleClose(cwd);

  console.log("[ISSUE-AGENT] run-once: next-issue");
  const next = await runNextIssue(cwd, ["--claim"]);
  console.log(`[ISSUE-AGENT] run-once result: ${JSON.stringify(next)}`);
}

if (import.meta.main) {
  await runOnce();
}
