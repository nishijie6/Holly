# Security policy

Security fixes target the current `main` branch. No separately maintained
release lines or response-time guarantee are currently offered.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/nishijie6/Holly/security/advisories/new).
Include the affected revision, reproduction steps, expected/actual behavior and
potential impact. Use invented accounts and test data; omit real tokens, personal
messages and authentication files. Do not publish exploit details in a public
issue before the maintainer has reviewed the report.

## Operating boundary

Holly's dashboard is a local, unauthenticated operator interface bound to
`127.0.0.1:5000`. It exposes chat history and configuration controls. Keep it on
loopback and use a private SSH tunnel for remote administration.

The OneBot/NapCat bridge is a trusted upstream: administrator identity depends
on the numeric user ID it supplies. Protect that bridge and its access token.
Ordinary chat content must not be treated as an administrator credential.

The public example starts QQ offline and read-only. Administrator code
improvement and autonomous actions require explicit local enablement.
Messages and model context may be sent to the configured LLM provider; review
its privacy terms and obtain appropriate consent for the conversations involved.

Keep `config.yaml`, `.env`, `.claude-oauth/`, `.codex/auth.json`, `data/`, `logs/`
and `archive/` private. If a credential is accidentally disclosed, revoke it at
the provider; removing it from Git history alone does not invalidate it.
