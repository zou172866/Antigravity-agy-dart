# Security Policy

## Supported Versions

| Version | Supported |
| :--- | :---: |
| `1.9.x` | Yes |
| `1.8.x` | Yes |
| `< 1.8.0` | Upgrade recommended |

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report vulnerabilities privately through [GitHub Security Advisories](https://github.com/zou172866/Antigravity-agy-dart/security/advisories/new). Include reproduction steps, affected operating system / Antigravity host version, and impact assessment. You can expect an initial response within 72 hours.

## Enforced Security Boundaries

1. **Zero Runtime Dependencies**: `agy-dart` uses built-in Node.js modules. Full-text indexing requires `node:sqlite` with FTS5 and its trigram tokenizer, available in official Node 22 builds from 22.16.0 and in Node 24 and later.
2. **Workspace Isolation (`roots/list` + `PLUGIN_ROOT` Fail-Fast Guard)**: Both `agy-dart_fast` and `agy-dart_context` lazily query MCP `roots/list` when `cwd` is omitted and immediately block relative/implicit operations that would fall back into an installed plugin directory.
3. **Read-Only Git Sandbox**: `batch_search(git)` and `SessionStart` snapshots inject `--no-optional-locks`, `-c core.fsmonitor=false`, `-c core.hooksPath=`, `-c diff.external=`, `-c gpg.program=false` (plus `openpgp`/`ssh`/`x509`), `--no-ext-diff`, `--no-textconv`, block `status -v` / `--ext*` / `--textc*`, and force `-n` on `remote show` so untrusted `.git/config` files cannot execute external binaries.
4. **SSRF & Secret Protection**: `ctx_index(url)` enforces per-hop DNS validation against loopback/private/link-local IPv4 & IPv6 ranges with resolved IP pinning. API keys, tokens, and credentials are redacted prior to SQLite FTS5 indexing and MCP output, with optional `sensitiveFileGuard: "deny"` for `.env` / key files.
5. **Loopback Sidecar Hardening**: The local dashboard binds strictly to `127.0.0.1`, validates `Host`, `Origin`, and `Sec-Fetch-Site` headers against DNS rebinding and cross-port CSRF, requires per-process tokens (`X-Agy-Dart-Token` / `X-Sidecar-Token`), and caps JSON request bodies at `64 KB`.
