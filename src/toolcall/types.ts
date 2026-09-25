import type { ConfirmedOutputEvent } from '../output/output-confirmation';

/**
 * ADR-0022's "derived assistant message": a view over committed output, never a commitment.
 * It is not hashed, not in the receipt, not in evidence, and never goes on chain.
 */
export interface DerivedAssistantMessage {
  readonly role: 'assistant';
  readonly content: string;
  readonly toolCalls: readonly DerivedToolCall[];
}

/**
 * Only what the model's own bytes determine. `id` / `type` / `index` are synthesized by the
 * Provider layer and are deliberately absent: they carry no model information, and putting them
 * here would invite treating them as part of the parse.
 */
export interface DerivedToolCall {
  readonly name: string;
  /**
   * The argument JSON exactly as the model wrote it. Not re-serialized: round-tripping through
   * JSON.parse/stringify reorders keys and changes bytes, and these bytes are what a
   * cross-language shared vector pins.
   */
  readonly arguments: string;
}

/**
 * Identifies a parser. `name` matches vLLM's --tool-call-parser and the manifest's
 * `tool_calling.parser.name`; `version` is the version of the behaviour spec, not of the engine.
 */
export interface ParserRef {
  readonly name: string;
  readonly version: string;
}

/**
 * What the provisional stream yields.
 *
 * `tool-call-provisional` means exactly what it says: nothing here has been reconciled with the
 * chain, so it MUST NOT be executed. The confirmed form is a different type, reachable only
 * through a function that requires a receipt.
 */
export type AssistantStreamEvent =
  | { readonly kind: 'content'; readonly text: string }
  | { readonly kind: 'tool-call-provisional'; readonly call: DerivedToolCall };

/** Incremental parse state. `push` is fed decoded text as it arrives; `finish` ends the stream. */
export interface ToolCallStreamState {
  push(text: string): readonly AssistantStreamEvent[];
  /** End of stream. An unclosed segment flushes as plain text (design S7 requirement 2). */
  finish(): readonly AssistantStreamEvent[];
}

export interface ToolCallParser extends ParserRef {
  parseComplete(text: string): DerivedAssistantMessage;
  createStreamState(): ToolCallStreamState;
}

/** Only reachable through `confirmAssistantMessageWithReceipt`, i.e. only after reconciliation. */
export interface ConfirmedAssistantMessage extends DerivedAssistantMessage {
  readonly confirmation: ConfirmedOutputEvent;
}

/**
 * Why this SDK is not entitled to parse. All are known before any frame arrives, which is why
 * they are resolved up front rather than delivered as a stream event (design S5.1).
 *
 * `parser-unverified` extends the four in design S6: ADR-0022 decision four's shared vectors do
 * not exist yet (monorepo#11), so a registry that reported an implemented-but-unchecked parser
 * as supported would claim precisely what cannot be claimed.
 *
 * `manifest-unavailable` and `manifest-hash-mismatch` are declared here but unreachable in
 * phase 1: the manifest layer is blocked on wire publishing V3 canonical vectors.
 */
export type UnsupportedReason =
  | 'parser-not-pinned'
  | 'parser-unknown'
  | 'parser-unverified'
  | 'manifest-unavailable'
  | 'manifest-hash-mismatch';

export type ToolCallSupport =
  | { readonly supported: true; readonly parser: ToolCallParser }
  | { readonly supported: false; readonly reason: UnsupportedReason };
