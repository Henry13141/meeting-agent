# Meeting Agent

This repository is a standalone open source meeting application.

- Preserve recording, local transcription, historical search, summaries and local action drafts.
- Main owns file operations, loopback services and provider credentials; Renderer uses a narrow Preload API.
- The meeting model service is text-only. Do not add shell, coding, arbitrary file or external write tools.
- Provider endpoint, model and key are configured by each user. Never embed a service account or pretend an unconfigured model succeeded.
- Local configuration, recordings, model weights, caches and generated output are excluded from Git. Do not log credentials or meeting content unnecessarily.
- Use Node.js 24, pnpm 10.15.1 and frozen lockfiles. Verify types, relevant tests, build and desktop behavior proportionately.
- Preserve third-party licenses and notices.
- First-run setup is described in 给Codex的首次配置指引.md. Cloud document integrations remain optional and are not currently implemented.
