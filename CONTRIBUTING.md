# Contributing to Holly

For questions and reproducible bugs, open a GitHub issue. For a vulnerability,
use the private channel described in [SECURITY.md](SECURITY.md).

## Development checks

Use Node.js 26 or newer:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
```

These checks work without QQ, provider credentials, `.env` or `config.yaml`.
To run the service itself, follow [docs/SETUP.md](docs/SETUP.md).

Submit a focused pull request against `main`, explaining the problem, the new
behavior and the checks you ran. Add a focused regression test when fixing a
behavioral bug. Preserve existing message routing, administrator authentication,
read-only restrictions and conversation privacy.

Use synthetic account/group IDs and short invented messages in tests. Runtime
settings belong in ignored local files. Changes to configuration should update
the public example and setup guide as well as its consumer code.

Do not attach credentials, authentication stores, private messages, raw logs,
database files, or identifying screenshots. Sanitize error reports before posting.
Do not force-add ignored configuration or runtime data.

Only include third-party code or assets that you have permission to distribute;
preserve the applicable source attribution and license notices. Contributions
to Holly are made under the repository's [MIT License](LICENSE).
