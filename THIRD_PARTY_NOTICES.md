# Third-party dependencies and models

The MIT license at the repository root covers this project's source. External packages, native runtimes and model files retain their own licenses and notices.

JavaScript dependencies are listed with exact versions in package.json and pnpm-lock.yaml. Python dependencies and optional engines are listed in each service's pyproject.toml and uv.lock. Their installed distributions contain the relevant license files. Preserve those notices when distributing dependencies or a packaged application; this repository does not include bundled binaries.

Model weights are not included. Obtain the model's license and model card with the exact version you use, and retain them with your local model package. The source license does not grant rights to third-party model weights. See models/meeting-asr/README.md for source links.

The 12 bundled local character video clips in apps/desktop/src/meeting-assistant/assets/character are distributed as project assets under the root MIT license. The local player does not include a cloud avatar SDK or require an avatar service account. No voice assets or model weights are bundled.

The optional Agent extension layer uses the official Python Model Context Protocol SDK, pinned as `mcp==2.3.0` in the Runtime lockfile, under its upstream MIT license. YAML Skill metadata is parsed with PyYAML and tool schemas are validated with jsonschema; their versions and transitive dependencies are recorded in the Runtime lockfile. Preserve the installed distributions’ license notices when redistributing them.

The mock office MCP server and office-assistant Skill in this repository are project examples under the root MIT license. They contain no third-party office SDK, account, access token or real platform connection. Connecting a separate MCP server or business API may add dependencies and platform terms; review and retain that adapter’s actual notices before redistribution. Skill instructions do not grant platform permissions or certify a third-party integration.
