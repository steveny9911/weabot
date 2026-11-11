/** The contract between the AI service and one model provider. Only adapters see native shapes. */

export interface ProviderRequest {
  /** Per-request instructions; providers place them above the conversation. */
  instructions?: string;
  userText: string;
  imageUrls: string[];
  /** Latest human request, sent after the untrusted conversation. */
  currentUserMessage?: string;
  /** Present only for replies that may call action tools. */
  tools?: Array<Record<string, unknown>>;
  format: "text" | "participation";
}

export interface ToolCall {
  /** Empty when the provider sent none. */
  id: string;
  name: string;
  /** JSON object text; undefined when the provider sent something else. */
  arguments: string | undefined;
}

export type ProviderStep =
  | {
      ok: true;
      /** Null when the response held no usable text. */
      text: string | null;
      toolCalls: ToolCall[];
      tokens: number;
    }
  | {
      ok: false;
      error: string;
      tokens: number;
    };

/** One conversation with the model, including its native history. */
export interface ProviderSession {
  /** Model calls made so far; read after a step even when it failed or timed out. */
  readonly calls: number;
  step(signal: AbortSignal): Promise<ProviderStep>;
  /** Adds the last step's output and one result per call, in order, before the next step. */
  addToolResults(calls: ToolCall[], results: string[]): void;
}

export interface AiProvider {
  /** Name used in error messages, e.g. "OpenAI". */
  label: string;
  /** Error returned when no API key is configured. */
  missingKeyError: string;
  start(request: ProviderRequest): ProviderSession;
}
