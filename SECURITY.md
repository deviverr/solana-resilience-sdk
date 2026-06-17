# Security Policy

## Supported versions

`solana-resilience-sdk` is pre-1.0; security fixes land on the latest `0.x`
release. Please track the most recent published version.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

- Preferred: use GitHub's private vulnerability reporting — the **"Report a
  vulnerability"** button under the repository's **Security** tab.
- Alternatively, email **dedpul3000a@gmail.com** with details and, if possible,
  a minimal reproduction.

You can expect an acknowledgement within a few days. Once a fix is available it
will be released as a new `0.x` version with the advisory published.

## Scope notes

This SDK handles RPC transport, transaction submission, and fee estimation. It
**never** takes custody of private keys — signing is delegated to the caller's
wallet/signer. Reports that involve key handling in your own integration code
are outside this project's scope, but we're happy to advise.
