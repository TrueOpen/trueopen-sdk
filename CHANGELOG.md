# Changelog

## Unreleased

### Added

- Resumable verified OUTPUT streaming with MMR checkpoints, strict duplicate-frame verification,
  idle timeout, and cross-Builder failover.
- Receipt confirmation against the locally verified MMR root, output leaf count, and byte size.
- OpenAI-compatible Chat Completion SSE adapters for Node `AsyncIterable` and browser
  `ReadableStream`, including provisional and confirmed-only delivery modes.
- Strict JSON V1 serialization for output checkpoints across Node and browser runtimes.

### Changed

- The CLI now rotates across discovered Builder endpoints instead of hanging indefinitely on the
  first endpoint without output.
- Confirmed-only SSE delivery has a 16 MiB default memory limit, supports `AbortSignal`, propagates
  stream cancellation, and avoids upstream prefetch until consumer demand.

### Known limitations

- Exact optional `resume_after_seq` presence remains blocked on TrueOpen/wire#28.
- Worker-authenticated Fin reason/signature and real streamed terminal SSE remain blocked on
  TrueOpen/wire#35, TrueOpen/cortex#382, and TrueOpen/nexus#99.
