# Meeting Agent

This repository is a standalone open source meeting application.

- Preserve recording, local transcription, historical search, summaries and local action drafts.
- Main owns file operations, loopback services and provider credentials; Renderer uses a narrow Preload API.
- The meeting agent may use locally configured MCP tools and SKILL.md workflows. Keep model-selected tools limited to the active skills and configured server allowlists. External write operations require a specific user confirmation before dispatch.
- Do not expose unrestricted shell, coding or arbitrary file tools. Configured MCP server processes are integration adapters, not a model-controlled command executor.
- Provider endpoint, model and key are configured by each user. Never embed a service account or pretend an unconfigured model succeeded.
- Local configuration, recordings, model weights, caches and generated output are excluded from Git. Do not log credentials or meeting content unnecessarily.
- Use Node.js 24, pnpm 10.15.1 and frozen lockfiles. Verify types, relevant tests, build and desktop behavior proportionately.
- Preserve third-party licenses and notices.
- First-run setup is described in 给Codex的首次配置指引.md. Cloud document integrations remain optional and are not currently implemented.
