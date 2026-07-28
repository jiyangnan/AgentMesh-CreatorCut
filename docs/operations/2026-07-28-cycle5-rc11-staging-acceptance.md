# CreatorCut Cycle 5 RC11 staging acceptance

Date: 2026-07-28

## Scope

This record closes the RC staging acceptance gate. It does not claim a stable
Core activation, production deployment, paid production canary or public
launch.

## Immutable RC identity

- Public tag: `v0.1.0-rc.11`
- Public commit: `103883bd2621a06bd5f9e75267cb203d027b54ec`
- Canonical source archive SHA-256:
  `70b36cb7153e06acaccef85b92502cd67cf9d004b0a120967fb64cfe7c9ca5f0`
- Private Server protocol lock: `236211b`
- Deployment policy lock: `d92cc44`

## Signed installation and staging gates

- The official GitHub installer verified the recovery-root-signed keyset,
  staging ReleaseManifest, exact tag, commit and canonical archive.
- The isolated managed installation reported CreatorCut `0.1.0-rc.11` and
  Node.js `24.14.0` even when launched from an ambient Node.js 25 shell.
- Staging Core, CreatorCut API, Worker, PostgreSQL and public TLS health checks
  passed.
- `creatorcut.director.plan` remained priced at 50 credits.
- `CREATORCUT_ENABLED`, `MONETIZATION_LIVE` and
  `DIRECTOR_ACCEPT_NEW_GENERATIONS` all remained `false`.

## Three-material evidence

| Material | Output SHA-256                                                     |    Duration | Video contract                      | Comparison evidence                                                                                          |
| -------- | ------------------------------------------------------------------ | ----------: | ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| JobAgent | `dc804f6157a96e603b6a1449891a5439595f2cc1cd93037979cdb21e18def453` |    26.252 s | 3840×2160 HEVC Main 10, HLG/BT.2020 | full repeat export matched byte-for-byte; accepted-output audio PSNR >165 dB and overall video SSIM 0.997264 |
| FocuSee  | `6517e21de1c45895c14821d9419faa548bd55b8deec11c8fc31cac5a56770484` | 23.166667 s | 1920×1080 H.264, SDR BT.709         | matched the accepted output byte-for-byte                                                                    |
| Codex    | `8ee7ba79af330c4f01b91a9ee4890beb92226fbf9b218bb1dea686eb45a49b55` |   215.250 s | 2160×3840 HEVC Main 10, HLG/BT.2020 | accepted-output audio PSNR >162 dB and overall video SSIM 0.995078                                           |

The RC11 renderer applies no implicit `zscale`, tone mapping, desaturation,
forced BT.709 conversion or creative LUT when `lut_none` is selected. A
parallel real-media six-second 4K HLG repeat probe also produced identical
output SHA-256 values after input decoding, filter scheduling and x265
frame/lookahead scheduling were pinned.

## Verification

- Public repository: formatting, typecheck, build, 88 package tests and 18
  public-contract tests passed under Node.js 24.
- Private Server: formatting, typecheck, build and 61 tests passed; 7
  environment-specific tests remained intentionally skipped.
- Deployment bundle: three CreatorCut staging tests and repository syntax
  checks passed. The unchanged deployment code path had already passed the
  complete 615-test suite before the RC metadata advance.

## Remaining fixed order

1. Freeze the stable commit, tag and canonical archive.
2. Deploy production Server/Core/shared Caddy in dark/gated mode.
3. Run the separately approved paid production canary and rollback drill.
4. Activate the Core stable ReleaseManifest last.
5. Reinstall from the final public channel and run the production smoke.
