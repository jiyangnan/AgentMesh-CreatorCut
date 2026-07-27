# CreatorCut M1 privacy contract

Original media stays local by default. CreatorCut Director receives only the
schema-validated `DirectorContext` that the user inspected and approved for the
current project revision.

The M1 context may include complete transcript text, token timing, silence
intervals, project/timeline digests, opaque asset references, canvas and
capability facts. Transcript text is user content; it is not described as
anonymized.

The default context excludes:

- original video or audio bytes;
- screenshots, representative frames, OCR text or thumbnails;
- relative or absolute local paths;
- usernames, home directories and shell state;
- API keys, Service Tokens and signing private keys.

Consent is stored locally with mode `0600`. It contains only consent metadata
and digests, not another copy of transcript text. A revision, transcript,
timeline, EditBrief, capability or consent-version change invalidates the prior
approval.

Revoking local consent blocks new context upload. Deleting a cloud Director
session does not delete or damage the local project.
