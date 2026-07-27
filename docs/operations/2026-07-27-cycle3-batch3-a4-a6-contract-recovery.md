# Cycle 3 / Batch 3 A4-A6 contract and recovery evidence

- Date: 2026-07-27
- Scope: fixed work packages A4, A5 and A6 only
- Runtime: Node 24.18.0, pnpm 10.30.3
- State: local public-repository checkpoint; no push, tag, deploy or release

## Fixed digests

- Protocol v1 bundle:
  `sha256:951723362bd171ad35a2194d2aa284b470db25f766bd46598b23268c9fbef59d`
- Operations bundle:
  `sha256:66f5ff82dea27c1e8b3ac572f1847be4c36fbefffa4b558d5d1ab3663d49bfc4`
- `cycle3-closeout-v1` fixture:
  `sha256:00975986abab5256b187a0394869fb408a815513be49d6850531d38c9a04206b`
- Manifest envelope:
  `sha256:7a9d47a7190a5252d82b38eb3a4e28b5f417e7ead8f88fae8fc595f738dd9b83`
- Expected direction AnswerSet:
  `sha256:2d6927b43a55ee7adaec27523e375dd17e19cfb6c1c98a1bc1c3ea0a39f4a6f2`

## Named evidence

| Test file                                                       | Cases | Evidence                                                                                                                                        |
| --------------------------------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/director-client/test/adapter.test.ts`                 |     5 | full signed chain/input/identifier binding; Generation ID persisted before POST; lost response reuses the same ID; mismatched response rejected |
| `packages/operations-contract/test/contract.test.ts`            |     5 | all 13 types accepted; missing/extra/wrong-type rejection; all operation-specific reversed ranges rejected                                      |
| `packages/media-engine/test/operation-matrix.test.ts`           |    13 | one deterministic apply golden case for each advertised operation                                                                               |
| `packages/media-engine/test/media-engine.test.ts`               |     8 | ref failure matrix, preview bytes/Manifest/revision tamper rejection and explicit export overwrite                                              |
| `packages/transcription/test/transcription.test.ts`             |     4 | mixed transcription recovery, symlink escape rejection and revision-bound resume                                                                |
| `apps/mcp/test/service.test.ts`                                 |     2 | envelope digest is the signed envelope digest and presentation digest is separate                                                               |
| `packages/client-capabilities/test/client-capabilities.test.ts` |     1 | canonical rich Codex and non-rich host capability profiles                                                                                      |
| `packages/host-adapters/test/adapter.test.ts`                   |     3 | all host adapters use the same capability builder and fail closed on stale submissions                                                          |
| `tests/public-contract/cycle3-closeout-fixture.test.mjs`        |     4 | real Server fixture verification/apply plus keyset, signature, chain, binding and operation tampering                                           |
| `tests/public-contract/protocol-bundle-lock.test.mjs`           |     1 | frozen Protocol v1 digest fails closed on public-package drift                                                                                  |

The complete Node 24 `pnpm verify` result was 58 Vitest cases plus 9 Node
public-contract cases, all passing. `git diff --check` also passed.

## A6 disposition

1. Duplicate capability builders were replaced by
   `@agentmesh/creatorcut-client-capabilities`, consumed by runtime and host
   adapters. It is outside the frozen Protocol v1 package.
2. MCP `envelope_digest` now hashes the signed envelope; the host presentation
   hash is returned separately as `presentation_digest`.
3. Transcription source validation checks both lexical containment and
   canonical realpath containment.
4. Transcription resume validates project, revision, source and source digest
   before returning either running or completed state.

Kimi CLI session `session_94175357-6db9-4064-8dcd-f86c6536362e` initially
returned FAIL because the first capability-builder location changed the frozen
Protocol digest. After relocation, the restored digest, public lock test and
Node 24 verification, the same session returned `A4+A6 PASS`.

## Scope limits

- The A3 fixture renderer remains a shell-free mock and is not new real FFmpeg
  evidence. The prior Batch 2 real FFmpeg import/proxy/export smoke remains the
  relevant media smoke.
- Codex native cards, Claude Code/OpenClaw Skills and real four-host
  interruption recovery are work packages B-D and remain incomplete.
- No Core, private Server, staging, production, billing, release channel or
  user media was changed by A4-A6.
