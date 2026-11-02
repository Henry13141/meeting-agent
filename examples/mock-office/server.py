"""Local-only MCP office fixture. Does not connect to any real office platform."""
from __future__ import annotations

import argparse
import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from mcp.server import MCPServer
from mcp.types import ToolAnnotations

PROJECT_ROOT = Path(__file__).resolve().parents[2]
MAX_DOCUMENT_CHARS = 100_000
MAX_RECORDS = 1_000


def create_server(data_directory: Path) -> MCPServer:
    # Only the operator's startup configuration selects this root. Tool arguments
    # never contain paths; records get generated identifiers and fixed suffixes.
    root = data_directory.expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    lock = threading.Lock()
    server = MCPServer(
        'Mock Office (local example)',
        instructions='All documents and tasks are local mock files, never real platform writes.',
        log_level='ERROR',
    )

    def text(value: str, name: str, maximum: int, *, required: bool = False) -> str:
        value = value.strip()
        if len(value) > maximum or (required and not value):
            raise ValueError(f'{name} must contain {"1" if required else "0"}..{maximum} characters')
        return value

    def records() -> list[Path]:
        files = sorted(root.glob('*.json'))
        if len(files) > MAX_RECORDS:
            raise ValueError(f'Mock storage exceeds {MAX_RECORDS} records; archive files before continuing')
        return files

    def save(kind: str, fields: dict[str, str]) -> dict[str, object]:
        with lock:
            if len(records()) >= MAX_RECORDS:
                raise ValueError(f'Mock storage is full ({MAX_RECORDS} records)')
            identifier = str(uuid.uuid4())
            record = {
                'id': identifier, 'kind': kind, **fields,
                'createdAt': datetime.now(timezone.utc).isoformat(),
                'storage': 'local-mock',
            }
            filename = f'{kind}-{identifier}.json'
            target = root / filename
            # Exclusive creation rejects a preexisting file or symlink. Flushing
            # before returning makes a successful receipt mean a persisted write.
            with target.open('x', encoding='utf-8') as handle:
                json.dump(record, handle, ensure_ascii=False, indent=2)
                handle.write('\n')
                handle.flush()
                os.fsync(handle.fileno())
            return {'created': True, 'storage': 'local-mock', 'id': identifier,
                    'path': filename, 'record': record, 'relativeFile': filename}

    @server.tool(annotations=ToolAnnotations(readOnlyHint=True))
    def search_documents(query: str) -> dict[str, object]:
        """Search this example's local mock documents. Never searches a real office platform."""
        query = text(query, 'query', 500).casefold()
        limit = 50
        matches = []
        with lock:
            for source in records():
                if source.is_symlink() or not source.is_file():
                    raise ValueError('Mock storage contains a non-regular record')
                if source.stat().st_size > 1_000_000:
                    raise ValueError('Mock record exceeds the 1 MB safety limit')
                record = json.loads(source.read_text(encoding='utf-8'))
                if not isinstance(record, dict):
                    raise ValueError('Mock record is not a JSON object')
                if record.get('kind') != 'document':
                    continue
                if query in f"{record.get('title', '')}\n{record.get('content', '')}".casefold():
                    matches.append(record)
        return {'storage': 'local-mock', 'documents': matches[:limit], 'total': len(matches),
                'hasMore': len(matches) > limit}

    @server.tool(annotations=ToolAnnotations(readOnlyHint=False))
    def create_document(title: str, content: str) -> dict[str, object]:
        """Write one local mock document. Requires confirmation in the meeting application."""
        return save('document', {'title': text(title, 'title', 200, required=True),
                                 'content': text(content, 'content', MAX_DOCUMENT_CHARS, required=True)})

    @server.tool(annotations=ToolAnnotations(readOnlyHint=False))
    def create_task(title: str, assignee: str = '', due_date: str = '') -> dict[str, object]:
        """Write one local mock task, without assigning it in any real task system."""
        return save('task', {'title': text(title, 'title', 200, required=True),
                            'assignee': text(assignee, 'assignee', 200),
                            'dueDate': text(due_date, 'due_date', 100)})

    return server


def main() -> None:
    parser = argparse.ArgumentParser(description='Run a local mock office MCP server')
    parser.add_argument('--transport', choices=['stdio', 'streamable-http'], default='stdio')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--data-dir', type=Path, default=Path(os.environ.get('MOCK_OFFICE_DATA_ROOT', PROJECT_ROOT / '.local-data' / 'mock-office')))
    options = parser.parse_args()
    if not 1 <= options.port <= 65535:
        parser.error('--port must be between 1 and 65535')
    server = create_server(options.data_dir)
    if options.transport == 'stdio':
        server.run(transport='stdio')
    else:
        # The example only binds loopback. Real remote adapters must implement
        # platform authentication themselves; this fixture contains no accounts.
        server.run(transport='streamable-http', host='127.0.0.1', port=options.port)


if __name__ == '__main__':
    main()
