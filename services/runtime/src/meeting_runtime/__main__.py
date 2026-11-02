"""Owner starts service with one bootstrap line; stdin EOF ends service lifetime."""
import asyncio
import json
import os
import sys
from pathlib import Path

import uvicorn

from .app import ModelConfig, create_app


def main():
    try:
        line = sys.stdin.buffer.readline(131073)
        if len(line) > 131072 or not line.endswith(b'\n'):
            raise ValueError('BOOTSTRAP_INVALID')
        config = json.loads(line)
        if (config['schemaVersion'] != 'meeting-runtime.v1' or
                type(config['port']) is not int or not 0 < config['port'] < 65536 or
                not isinstance(config['bearerToken'], str) or len(config['bearerToken']) < 32 or
                config.get('exitOnStdinClose') is not True or not Path(config['dataRoot']).is_absolute()):
            raise ValueError('BOOTSTRAP_INVALID')
        model = ModelConfig(**config['model']) if config.get('model') else None
        project_root = Path(config['projectRoot']) if config.get('projectRoot') else None
        environment = config.get('integrationEnvironment', {})
        if (project_root and not project_root.is_absolute() or not isinstance(environment, dict) or
                len(environment) > 64 or len(json.dumps(environment).encode()) > 65536 or any(not isinstance(k, str) or not isinstance(v, str) or len(v) > 8192
                                              for k, v in environment.items())):
            raise ValueError('BOOTSTRAP_INVALID')
        app = create_app(Path(config['dataRoot']), config['bearerToken'], model, project_root, environment)
    except Exception:
        sys.stderr.write('MEETING_RUNTIME_BOOTSTRAP_INVALID\n')
        raise SystemExit(1) from None

    async def run():
        server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=config['port'],
                                              log_level='error', access_log=False))
        async def owner():
            await asyncio.to_thread(sys.stdin.buffer.read)
            server.should_exit = True
        watcher = asyncio.create_task(owner())
        try:
            await server.serve()
        finally:
            watcher.cancel()
        os._exit(0)
    asyncio.run(run())


if __name__ == '__main__':
    main()
