import type { FinishReasonV1 } from '../gen/task/v1/evidence_pb.js';
import type { ChatTool } from '../order/chat-input';
import type { ConfirmedOutputEvent } from '../output/output-confirmation';

/**
 * ADR-0022's "derived assistant message": a view over committed output, never a commitment.
 * It is not hashed, not in the receipt, not in evidence, and never goes on chain.
 */
export interface DerivedAssistantMessage {
  readonly role: 'assistant';
  readonly content: string;
  readonly toolCalls: readonly DerivedToolCall[];
  /**
   * The leading reasoning span (Manifest S7.3), set only when a reasoning parser ran and found
   * one. Tool-call markers inside it are reasoning text: they never appear in `toolCalls`.
   */
  readonly reasoningContent?: string;
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
 * Identifies a parser, matching the manifest's `tool_calling.parser` (Manifest S7.2).
 *
 * `name` is TrueOpen's **engine-independent canonical** name, drawn from the governance
 * whitelist `supported_tool_call_parsers`. It is deliberately *not* an engine's own parser
 * name: those disagree across engines -- Phi-4 is `phi4_mini_json` in vLLM and `phi4` in
 * Dynamo -- so a node maps the canonical name onto whatever its local engine calls it. An
 * implementation that looked up an engine's registry by this name would be right on one
 * engine and wrong on the next.
 *
 * `version` is the version of that canonical parser *specification*, not of any engine, and
 * is `>= 1`. Same name at a different version is a different parser.
 */
export interface ParserRef {
  readonly name: string;
  readonly version: number;
}

/**
 * What the provisional stream yields.
 *
 * `tool-call-provisional` means exactly what it says: nothing here has been reconciled with the
 * chain, so it MUST NOT be executed. The confirmed form is a different type, reachable only
 * through a function that requires a receipt.
 */
export type ToolCallStreamEvent =
  | { readonly kind: 'content'; readonly text: string }
  | { readonly kind: 'tool-call-provisional'; readonly call: DerivedToolCall };

/**
 * A tool-call stream event, or a piece of the leading reasoning span when a reasoning parser
 * runs (Manifest S7.3). Reasoning is as provisional as everything else before the receipt.
 */
export type AssistantStreamEvent = ToolCallStreamEvent | { readonly kind: 'reasoning'; readonly text: string };

/**
 * What a parser may know besides the committed output.
 *
 * `tools` is the request's tool list, i.e. the `tools` of the committed chat input
 * (`input_hash` covers it). A parser whose format writes argument values as plain text
 * (qwen3_coder@1) reads each parameter's JSON Schema type from it; a parser that receives JSON
 * arguments (hermes@1) ignores it. The stream and the confirmation must be given the same list.
 */
export interface ToolCallContext {
  readonly tools?: readonly ChatTool[];
}

/**
 * How the end of the output is to be read. Given only by a caller that knows the verified
 * protocol finish reason (design S7 requirement 6).
 */
export interface ToolCallParseOptions extends ToolCallContext {
  /**
   * The model stopped by itself (the signed Fin says EOS_TOKEN or STOP_SEQUENCE), so a final
   * call whose closing marker never came is complete if its body parses: recover it as a call,
   * as vLLM and Dynamo do. Without it -- truncated, stopped by the user, or the reason
   * unavailable -- an unclosed segment flushes as plain text.
   */
  readonly recoverUnclosedAtEnd?: boolean;
}

/** Incremental parse state. `push` is fed decoded text as it arrives; `finish` ends the stream. */
export interface ToolCallStreamState {
  push(text: string): readonly ToolCallStreamEvent[];
  /** End of stream. An unclosed segment flushes as plain text unless recovered (design S7 requirement 6). */
  finish(opts?: ToolCallParseOptions): readonly ToolCallStreamEvent[];
}

export interface ToolCallParser extends ParserRef {
  parseComplete(text: string, opts?: ToolCallParseOptions): DerivedAssistantMessage;
  createStreamState(ctx?: ToolCallContext): ToolCallStreamState;
}

/** Only reachable through `confirmAssistantMessageWithReceipt`, i.e. only after reconciliation. */
export interface ConfirmedAssistantMessage extends DerivedAssistantMessage {
  readonly confirmation: ConfirmedOutputEvent;
  /**
   * The protocol termination reason from the Worker-signed Fin, verified against the receipt
   * (the same value as `confirmation.finishReason`). Undefined when no signed Fin was kept: the
   * reason is unavailable, and must not be guessed.
   */
  readonly finishReason?: FinishReasonV1;
}

/**
 * Why this SDK is not entitled to parse. All are known before any frame arrives, which is why
 * they are resolved up front rather than delivered as a stream event (design S5.1).
 *
 * `parser-unverified` extends the two in design S6: ADR-0022 decision four's shared vectors do
 * not exist yet (monorepo#11), so a registry that reported an implemented-but-unchecked parser
 * as supported would claim precisely what cannot be claimed.
 *
 * The parser is read from the profile's on-chain `tool_call_parser` projection, which is
 * authoritative, so there is no manifest fetch/hash/validate step that could fail: the three
 * manifest failure modes the earlier design carried are gone. Full-document verification (of the
 * artifacts, `output_decoding`, etc.) is a separate concern handled by `manifestHash` +
 * `assertManifestMatchesChain`, not by tool-call resolution.
 */
export type UnsupportedReason =
  | 'parser-not-pinned'
  | 'parser-unknown'
  | 'parser-unverified';

export type ToolCallSupport =
  | { readonly supported: true; readonly parser: ToolCallParser }
  | { readonly supported: false; readonly reason: UnsupportedReason };
