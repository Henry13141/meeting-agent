# Third-party dependencies and models

The MIT license at the repository root covers this project's source. External packages, native runtimes and model files retain their own licenses and notices.

JavaScript dependencies are listed with exact versions in package.json and pnpm-lock.yaml. Python dependencies and optional engines are listed in each service's pyproject.toml and uv.lock. Their installed distributions contain the relevant license files. Preserve those notices when distributing dependencies or a packaged application; this repository does not include bundled binaries.

Model weights are not included. Obtain the model's license and model card with the exact version you use, and retain them with your local model package. The source license does not grant rights to third-party model weights. See models/meeting-asr/README.md for source links.

The meeting state illustration is implemented directly as SVG/CSS source in this repository. No external avatar images, videos or voice assets are distributed.
