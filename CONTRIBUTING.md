# Contributing

Thanks for helping improve Gitbraid.

## Before you start

- Open an issue describing the bug or change before large pull requests, so the approach can be agreed first.
- Keep changes focused. One pull request should do one thing.
- Never commit credentials, account IDs, `.dev.vars`, or generated `worker-configuration.d.ts`.

## Development

```sh
npm ci
npm run cf:types
npm run typecheck
npm run build
```

`npm run dev` serves the app locally with local Durable Object storage. It does not prove Cloudflare integrations such as Artifacts, Containers or AI Gateway; say what you verified and how in your pull request.

## Product rules

- Every action available in the UI must also be available through MCP, with the same authorization checks.
- Coding agents never receive owner, deployment or canonical repository credentials.
- Approval binds an exact candidate commit and base; landing must refuse anything else.
- AI features must stay optional: with `AI_FEATURES=disabled` no model is called and AI-only screens are hidden.
- Keep code comments rare: explain constraints the code cannot show, not what it does.

## Licence

By contributing you agree that your contribution is licensed under the same licence as this repository (see `LICENSE`).
