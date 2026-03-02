import {
  buildMarker,
  commentOnIssue,
  ensureAgentLabels,
  findLatestDecisionComment,
  getCurrentGhLogin,
  issueHasLabel,
  issueUpdatedAfter,
  listOpenIssues,
  setIssueStateLabel,
  viewIssue,
  type AgentDecision,
  type GhIssue,
} from "./common.ts";

type TriageReason =
  | "missing-details-bug"
  | "missing-details-feature"
  | "inappropriate-request"
  | "accepted";

interface TriageResult {
  decision: AgentDecision;
  reason: TriageReason;
  summary: string;
  details: string[];
}

function normalize(text: string): string {
  return text.toLowerCase();
}

function isLikelyBug(text: string): boolean {
  return /(bug|error|crash|exception|stack trace|traceback|not work|fails?|failure|broken)/i
    .test(text);
}

function isLikelyFeature(text: string): boolean {
  return /(feature|enhancement|request|would like|please add|support|improvement|proposal)/i
    .test(text);
}

function hasReproSteps(text: string): boolean {
  return /(steps? to repro|steps? to reproduce|repro|1\.|2\.|when i|how to reproduce)/i.test(
    text,
  );
}

function hasExpected(text: string): boolean {
  return /(expected|should happen|wanted|supposed to)/i.test(text);
}

function hasActual(text: string): boolean {
  return /(actual|instead|got|observed|currently)/i.test(text);
}

function hasEnvironment(text: string): boolean {
  return /(deno|node|mac|linux|windows|discord|version|browser|os|channel)/i.test(text);
}

function hasEvidence(text: string): boolean {
  return /(```|error|log|trace|screenshot|stack|exception)/i.test(text);
}

function hasFeatureUseCase(text: string): boolean {
  return /(use case|so that|because|problem|motivation|why)/i.test(text);
}

function hasAcceptanceCriteria(text: string): boolean {
  return /(acceptance|done when|should|must|expected behavior|success criteria)/i.test(text);
}

function isInappropriateRequest(text: string): boolean {
  return /(malware|ransomware|phish|phishing|steal token|token stealer|doxx|ddos|spam bot|credential stuffing|hack.*account|keylogger)/i
    .test(text);
}

function triageIssue(issue: GhIssue): TriageResult {
  const combined = `${issue.title}\n${issue.body ?? ""}`.trim();
  const lower = normalize(combined);

  if (isInappropriateRequest(lower)) {
    return {
      decision: "rejected",
      reason: "inappropriate-request",
      summary: "Rejected by automation for safety/policy reasons.",
      details: [
        "This request appears to involve harmful, abusive, or otherwise inappropriate behavior.",
        "Automation will not generate code or instructions for this type of request.",
      ],
    };
  }

  const bug_like = isLikelyBug(lower);
  const feature_like = isLikelyFeature(lower);
  const body_len = (issue.body ?? "").trim().length;

  if (bug_like) {
    const checks = [
      hasReproSteps(combined),
      hasExpected(combined),
      hasActual(combined),
      hasEnvironment(combined),
      hasEvidence(combined),
    ];
    const score = checks.filter(Boolean).length;
    if (score < 2 || body_len < 40) {
      return {
        decision: "needs-info",
        reason: "missing-details-bug",
        summary: "Needs more bug details before automation can implement a fix.",
        details: [
          "Please include clear steps to reproduce.",
          "Please include expected behavior vs actual behavior.",
          "Please include environment details (OS/runtime/versions).",
          "Attach logs/errors/screenshots if available.",
        ],
      };
    }
  }

  if (feature_like) {
    if (!hasFeatureUseCase(combined) || !hasAcceptanceCriteria(combined) || body_len < 40) {
      return {
        decision: "needs-info",
        reason: "missing-details-feature",
        summary: "Needs more feature details before automation can implement it.",
        details: [
          "Please describe the user/problem use case.",
          "Please include clear acceptance criteria (what counts as done).",
          "Include examples of desired behavior/output if possible.",
        ],
      };
    }
  }

  if (!bug_like && !feature_like && body_len < 30) {
    return {
      decision: "needs-info",
      reason: "missing-details-feature",
      summary: "Issue is too short to triage confidently.",
      details: [
        "Please add more context about what should be changed.",
        "Include expected behavior and any constraints.",
      ],
    };
  }

  return {
    decision: "accepted",
    reason: "accepted",
    summary: "Accepted by automation for implementation.",
    details: [
      "Automation will attempt implementation and open a PR when successful.",
      "If the scope changes, update this issue with additional details.",
    ],
  };
}

function formatDecisionComment(result: TriageResult): string {
  const emoji = result.decision === "accepted"
    ? "✅"
    : (result.decision === "needs-info" ? "🟡" : "⛔");
  const heading = result.decision === "accepted"
    ? "Haru automation triage: accepted"
    : (result.decision === "needs-info"
      ? "Haru automation triage: needs more info"
      : "Haru automation triage: rejected");
  const bullets = result.details.map((line) => `- ${line}`).join("\n");

  return [
    buildMarker(result.decision, result.reason),
    `${heading} ${emoji}`,
    "",
    result.summary,
    "",
    bullets,
    "",
    "If you update this issue, the automation will re-triage it on the next run.",
  ].join("\n");
}

function toStateLabel(decision: AgentDecision): "agent:accepted" | "agent:needs-info" | "agent:rejected" {
  if (decision === "accepted") return "agent:accepted";
  if (decision === "needs-info") return "agent:needs-info";
  return "agent:rejected";
}

export async function runTriage(cwd = Deno.cwd()): Promise<void> {
  await ensureAgentLabels(cwd);
  const actor = await getCurrentGhLogin(cwd);
  const issues = await listOpenIssues(cwd);

  let reviewed = 0;
  let changed = 0;
  let accepted = 0;
  let needsInfo = 0;
  let rejected = 0;

  for (const summary of issues) {
    if (issueHasLabel(summary, "agent:pr-open") || issueHasLabel(summary, "agent:in-progress")) {
      continue;
    }

    const issue = await viewIssue(summary.number, cwd);
    reviewed++;
    const latest = findLatestDecisionComment(issue, actor);

    const should_retriage = !latest || issueUpdatedAfter(issue.updatedAt, latest.at);
    if (!should_retriage) {
      continue;
    }

    const result = triageIssue(issue);
    const target_label = toStateLabel(result.decision);
    const current_state = issue.labels.find((l) =>
      l.name === "agent:accepted" || l.name === "agent:needs-info" || l.name === "agent:rejected"
    )?.name;

    const comment_body = formatDecisionComment(result);
    const decision_changed = !latest || latest.decision !== result.decision || latest.reason !== result.reason;

    if (decision_changed || issueUpdatedAfter(issue.updatedAt, latest?.at ?? "")) {
      await commentOnIssue(issue.number, comment_body, cwd);
    }

    if (current_state !== target_label) {
      await setIssueStateLabel(issue, target_label, cwd);
    }

    changed++;
    if (result.decision === "accepted") accepted++;
    if (result.decision === "needs-info") needsInfo++;
    if (result.decision === "rejected") rejected++;
  }

  console.log(
    `[ISSUE-AGENT] triage complete reviewed=${reviewed} changed=${changed} accepted=${accepted} needs_info=${needsInfo} rejected=${rejected}`,
  );
}

if (import.meta.main) {
  await runTriage();
}
