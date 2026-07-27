# CreatorCut operations contract

`creatorcut-operations/1.0` is the public, strict adjunct contract for
CreatorCut edit-operation parameters and preconditions.

It intentionally does not change the frozen `creatorcut-director-protocol/1.0`
bundle. Private Director services and public local executors consume the same
packed validator and vectors, pin the operations digest, and keep local IDs out
of signed wire artifacts.
