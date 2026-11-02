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
        config = json.loads(sys.stdin.buffer.readline(16385))
        if (config['schemaVersion'] != 'meeting-runtime.v1' or
                not isinstance(config['port'], int) or not 0 < config['port'] < 65536 or
                not isinstance(config['bearerToken'], str) or len(config['bearerToken']) < 32 or
                config.get('exitOnStdinClose') is not True or not Path(config['dataRoot']).is_absolute()):
            raise ValueError('BOOTSTRAP_INVALID')
        model = ModelConfig(**config['model']) if config.get('model') else None
        app = create_app(Path(config['dataRoot']), config['bearerToken'], model)
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
