/** Text checks that decide whether a message explicitly asks for a Discord action. */

/** A conservative authorization gate, independent of the model's interpretation of details. */
export function directReferenceText(content: string): string {
  return (
    content
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`[^`]*`/g, " ")
      // Discord's >>> blockquote consumes every following line, not just its first.
      .replace(/^[ \t]*>>>(?:\s|$)[\s\S]*$/gm, " ")
      .replace(/^\s*>.*$/gm, " ")
  );
}
export function directRequestText(content: string): string {
  return directReferenceText(content).replace(/"[^"\n]*"|“[^”\n]*”/g, " ");
}
export function isDiscussion(content: string): boolean {
  const direct = directRequestText(content)
    .replace(/<@!?\d+>/g, " ")
    .trim();
  return (
    !direct ||
    /\b(hypothetical|hypothetically|example|pretend)\b/i.test(direct) ||
    /\bhow\s+(?:do|can|would|could|to)\b|\bwhat\s+(?:if|would)\b/i.test(direct)
  );
}
export function isNegativeRequest(content: string): boolean {
  return /\b(don['’]t|do not|not|never|stop|forget it|never mind|nevermind)\b/i.test(
    directRequestText(content),
  );
}
export function hasExplicitCancellationRequest(content: string): boolean {
  if (isNegativeRequest(content) || isDiscussion(content)) return false;
  const direct = directRequestText(content);
  // Cancelling a pending request is distinct from cancelling an existing event.
  if (/\b(?:request|creation|creating)\b/i.test(direct)) return false;
  return (
    /\b(?:cancel|call\s+off)\b/i.test(direct) &&
    (/\b(?:event|meetup|meeting|game night|movie night|watch party|hangout|session|party|workshop)\b/i.test(
      direct,
    ) ||
      /\b(?:cancel|call\s+off)\s+(?!please[.!?\s]*$)\S/i.test(direct) ||
      /\b(?:cancel|call\s+off)\s+["“][^"”\n]+["”]/i.test(content))
  );
}
export function isAbandonment(content: string): boolean {
  return (
    isNegativeRequest(content) ||
    (/\bcancel\b/i.test(directRequestText(content)) && !hasExplicitCancellationRequest(content))
  );
}
export function creationRequestText(content: string): string {
  const direct = directRequestText(content);
  if (isAbandonment(content) || /\b(?:cancel|call\s+off)\b/i.test(direct)) return "";
  return isDiscussion(content) ? "" : direct;
}
export function hasExplicitEventCreationRequest(content: string): boolean {
  const direct = creationRequestText(content);
  // An invite for an existing event does not authorize creating that event.
  // Keep independent event clauses and the common "event with an invite" form.
  const clauses = direct.split(/[.!?;\n]|\b(?:and|then|also)\b/i);
  return clauses.some((clause) => {
    const eventClause = clause.replace(
      /\bwith\s+(?:an?\s+)?(?:invite|invitation|join\s+link)\b.*$/i,
      " ",
    );
    return (
      !/\b(invite|invitation|join\s+link)\b/i.test(eventClause) &&
      /\b(event|meetup|meeting|game night|movie night|watch party|hangout|session|party|workshop)\b/i.test(
        eventClause,
      ) &&
      /\b(create|schedule|make|set\s+up|arrange|organ[is]e|plan|host|add)\b/i.test(eventClause)
    );
  });
}
export function hasExplicitInviteCreationRequest(content: string): boolean {
  const direct = creationRequestText(content);
  return (
    /\b(invite|invitation|join\s+link)\b/i.test(direct) &&
    /\b(create|make|get|give|send|share|generate|need|want)\b/i.test(direct)
  );
}
export function hasExplicitCreationRequest(content: string): boolean {
  return hasExplicitEventCreationRequest(content) || hasExplicitInviteCreationRequest(content);
}
export function hasExplicitActionRequest(content: string): boolean {
  return hasExplicitCreationRequest(content) || hasExplicitCancellationRequest(content);
}

export function containsReference(source: string, reference: string): boolean {
  const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(source);
}
