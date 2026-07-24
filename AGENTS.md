# AgentMesh-CreatorCut contribution rules

This is the public CreatorCut execution product. It is independent of
`AgentMesh360-Client`.

- Keep Director policy, prompts, evals, private signing keys, Core service
  credentials, and credit arbitration out of this repository.
- Keep user media, proxies, transcripts, project files, and local absolute paths
  on the user's machine unless a user explicitly inspects and consents to a
  DirectorContext upload.
- Public operations must be declarative, revision-bound, capability-gated,
  previewable, and reversible.
- Chinese, English, and mixed-language transcripts are first-class M1 inputs.
- Interactive cards are a protocol capability, not a Studio-only UI feature;
  every card must have a semantically equivalent text fallback.
- Do not advertise a CLI, MCP server, installer, remote release, or production
  Director until it exists and has been verified in this repository.
- Node 24 and pnpm 10 are the supported development baseline.
- Update `docs/DEVELOPMENT-STATUS.md` and `docs/test-cases/test-cases.md` with
  implementation and verification changes.
