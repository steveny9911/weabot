import type { AppConfig } from "../config.ts";
import {
  collectImageUrls,
  getImageUrlsFromContextMessage,
  MAX_CONTEXT_IMAGES,
  getReplyReference,
} from "./context_images.ts";
import { withResponseDeadline } from "./deadline.ts";
import { parseParticipation, participationInstructions } from "./participation.ts";
import { createAiProvider } from "./providers/index.ts";
import { sanitizeReply, uwuify, truncateText } from "./text.ts";
import type {
  AiErrorResult,
  AiParticipationOptions,
  AiReplyOptions,
  AiResult,
  AiService,
} from "./types.ts";

const MAX_TOOL_RESPONSES = 6;
const MAX_TOOL_CALLS = 8;
const RESPONSE_TIMEOUT_MS = 60_000;
const TOOL_LOOP_TIMEOUT_MS = 120_000;

/** A message's text, cut to `maxInputChars` (0 for no limit), with a note of its images. */
function describe(message: Record<string, unknown>, maxInputChars: number): string {
  const raw = (message["content"] as string) ?? "";
  const text = maxInputChars > 0 ? truncateText(raw, maxInputChars) : raw;
  const images = getImageUrlsFromContextMessage(message).length;
  if (images === 0) return text;
  return `${text} [attached ${images} ${images === 1 ? "image" : "images"}]`;
}

export function createAiService(
  config: AppConfig,
  runtime: {
    requestTimeoutMs?: number;
    toolLoopTimeoutMs?: number;
    now?: () => number;
  } = {},
): AiService {
  const requestTimeoutMs = runtime.requestTimeoutMs ?? RESPONSE_TIMEOUT_MS;
  const toolLoopTimeoutMs = runtime.toolLoopTimeoutMs ?? TOOL_LOOP_TIMEOUT_MS;
  const now = runtime.now ?? (() => performance.now());
  // With AI off no provider is built, so a provider that is named but not ready cannot stop startup.
  const provider = config.aiEnabled && config.aiProvider ? createAiProvider(config) : undefined;
  return {
    usageReport: provider?.usageReport?.bind(provider),
    async generateReply(
      messages: Array<Record<string, unknown>>,
      options?: AiReplyOptions | AiParticipationOptions,
    ): Promise<AiResult> {
      const participationOptions = options && "mode" in options ? options : undefined;
      const actionOptions = options && !("mode" in options) ? options : undefined;
      const contextIds = new Set(
        messages.flatMap((message) =>
          typeof message.id === "string" && message.id ? [message.id] : [],
        ),
      );
      const allowedMessageIds = new Set(
        participationOptions?.allowedMessageIds.filter((id) => contextIds.has(id)) ?? [],
      );
      if (!config.aiEnabled) {
        return { ok: false, error: "AI is disabled" };
      }

      if (!provider) return { ok: false, error: "ai.provider is not set" };
      if (!config.aiApiKey) {
        return { ok: false, error: `${config.aiApiKeyEnv} not set` };
      }

      const choices = participationOptions?.reactionChoices ?? [];
      const lines = messages.map((m) => {
        const author = (m.author as string) ?? "unknown";
        const label =
          participationOptions && typeof m.id === "string"
            ? `[message ID: ${m.id}${
                typeof m.turnId === "string"
                  ? `; turn: ${m.turnId}; reaction anchor: ${m.reactionAnchor === true}`
                  : ""
              }] ${author}`
            : author;
        const reference = getReplyReference(m);
        const text = describe(m, config.aiMaxInputChars);
        if (!reference) return `${label}: ${text}`;
        const referenceAuthor = (reference["author"] as string) ?? "unknown";
        const referenceText = describe(reference, config.aiMaxInputChars);
        return `${label} (replying to ${referenceAuthor}: ${referenceText}): ${text}`;
      });

      const userText = `Here is the recent conversation (oldest->newest):\n\n${lines.join(
        "\n",
      )}\n\n${
        participationOptions
          ? "Choose whether to reply, react, or remain silent using the developer instructions."
          : "Respond in-character as the assistant described in the system instructions."
      }${
        !participationOptions && messages.some((m) => m.author === "web")
          ? " If the web author supplied reference notes, use them to answer the question."
          : ""
      }`;

      const session = provider.start({
        instructions: participationOptions
          ? participationInstructions(participationOptions.instructions, allowedMessageIds, choices)
          : actionOptions?.instructions,
        userText,
        imageUrls: collectImageUrls(messages, MAX_CONTEXT_IMAGES),
        currentUserMessage: actionOptions?.currentUserMessage,
        tools: actionOptions?.tools,
        format: participationOptions ? "participation" : "text",
      });
      const allowedTools = new Set(
        (actionOptions?.tools ?? [])
          .filter((tool) => tool.type === "function" && typeof tool.name === "string")
          .map((tool) => tool.name as string),
      );
      const toolResults = new Map<string, string>();
      let tokensUsed = 0;
      let toolCallsUsed = 0;
      const failure = (error: string): AiErrorResult => ({
        ok: false,
        error,
        requestsUsed: session.calls,
        tokensUsed,
      });
      const toolDeadline = now() + toolLoopTimeoutMs;
      const toolTimeExpired = () => Boolean(actionOptions && now() >= toolDeadline);

      try {
        const maxResponses = actionOptions ? MAX_TOOL_RESPONSES : 1;
        for (let responseIndex = 0; responseIndex < maxResponses; responseIndex++) {
          if (toolTimeExpired()) return failure("AI tool time limit reached");
          const remainingMs = actionOptions ? toolDeadline - now() : requestTimeoutMs;
          const step = await withResponseDeadline(
            Math.min(requestTimeoutMs, remainingMs),
            actionOptions && remainingMs <= requestTimeoutMs
              ? "AI tool time limit reached"
              : `${provider.label} response timed out`,
            (signal) => session.step(signal),
          );
          tokensUsed += step.tokens;
          if (!step.ok) return failure(step.error);
          if (toolTimeExpired()) return failure("AI tool time limit reached");
          if (participationOptions) {
            const participation = parseParticipation(step.text, allowedMessageIds, choices);
            console.log("[AI] tokens used:", tokensUsed);
            console.log("[AI] participation:", participation.action);
            return {
              ok: true,
              text: participation.action === "reply" ? participation.text : "",
              tokensUsed: tokensUsed,
              requestsUsed: session.calls,
              participation,
            };
          }

          const calls = step.toolCalls;
          if (actionOptions && calls.length > 0) {
            // Leave a response available to report results before permitting any writes.
            if (responseIndex + 1 >= maxResponses) {
              return failure("AI tool response limit reached");
            }
            if (toolCallsUsed + calls.length > MAX_TOOL_CALLS) {
              return failure("AI tool call limit reached");
            }
            if (calls.some((call) => !call.id.trim())) {
              return failure("AI tool call is missing a call_id");
            }
            toolCallsUsed += calls.length;

            const results: string[] = [];
            for (const call of calls) {
              // Count tool execution time in the overall budget, but await an
              // in-flight mutation so its verified receipt is never lost to a race.
              if (toolTimeExpired()) return failure("AI tool time limit reached");
              let result = toolResults.get(call.id);
              if (result === undefined) {
                try {
                  if (!allowedTools.has(call.name)) {
                    throw new Error(`Unknown tool: ${call.name}`);
                  }
                  if (call.arguments === undefined) {
                    throw new Error("Tool arguments must be a JSON object");
                  }
                  const args: unknown = JSON.parse(call.arguments);
                  if (args === null || typeof args !== "object" || Array.isArray(args)) {
                    throw new Error("Tool arguments must be a JSON object");
                  }
                  result = JSON.stringify(
                    await actionOptions.executeTool(call.name, args as Record<string, unknown>),
                  );
                } catch (error) {
                  result = JSON.stringify({ ok: false, error: String(error) });
                }
                toolResults.set(call.id, result);
              }
              results.push(result);
            }
            session.addToolResults(calls, results);
            continue;
          }

          if (!step.text) return failure(`No text in ${provider.label} response`);

          const raw = step.text.trim();
          // Action outcomes and links must retain their exact meaning and punctuation.
          const finalText = options ? raw : uwuify(sanitizeReply(raw), config.aiEnableUwu);
          console.log("[AI] tokens used:", tokensUsed);
          console.log("[AI] raw reply:", raw);
          console.log("[AI] final reply:", finalText);
          return { ok: true, text: finalText, tokensUsed: tokensUsed, requestsUsed: session.calls };
        }
        return failure("AI tool response limit reached");
      } catch (err) {
        return failure(String(err));
      }
    },
  };
}
