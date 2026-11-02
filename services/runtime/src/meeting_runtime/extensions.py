"""Opt-in local skills and MCP adapters. Config and credentials never leave this process."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

import httpx2
import yaml
from jsonschema import validators
from mcp import Client
from mcp.client.stdio import DEFAULT_INHERITED_ENV_VARS, StdioServerParameters, stdio_client
from mcp.client.streamable_http import streamable_http_client
from pydantic import BaseModel, ConfigDict, Field

# SDK/HTTP diagnostics can contain server output, URL or authentication details.
for _name in ('mcp', 'httpx2', 'httpcore2'):
    logging.getLogger(_name).setLevel(logging.CRITICAL)

DEFAULT_LIMITS = {
    'configBytes': 262144, 'skillBytes': 131072, 'servers': 16, 'skills': 128,
    'tools': 256, 'schemaBytes': 65536, 'toolRounds': 8, 'toolCalls': 24,
    'discoveryTimeout': 15, 'toolTimeout': 30, 'approvalTimeout': 120,
    'resultBytes': 1048576, 'argumentsBytes': 65536, 'modelResponseBytes': 2097152,
}
HARD_LIMITS = {key: value * 8 for key, value in DEFAULT_LIMITS.items()}
HARD_LIMITS.update(discoveryTimeout=30, toolTimeout=300, approvalTimeout=1800,
                   servers=16, skills=128, tools=256, configBytes=262144)
SECRET_FIELD = re.compile(r'password|passphrase|secret|token|credential|auth|cookie|(?:api|private|access)[_-]?key', re.I)
SAFE_NAME = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
SERVER_ID = re.compile(r'^[A-Za-z][A-Za-z0-9-]{0,39}$')
# Integration adapters must expose domain operations, never a generic executor/filesystem API.
UNSAFE_TOOL = re.compile(r'(^|[_.-])(shell|bash|terminal|exec|execute|exec_command|run_code|read_file|write_file|filesystem)([_.-]|$)', re.I)


class ExtensionError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def fixed_error(error, fallback):
    """AnyIO transport task groups may wrap an application failure in ExceptionGroup."""
    if isinstance(error, ExtensionError):
        return error.code
    if isinstance(error, (TimeoutError, httpx2.TimeoutException)):
        return 'TOOL_TIMEOUT'
    for child in getattr(error, 'exceptions', ()):
        code = fixed_error(child, None)
        if code:
            return code
    return fallback


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class Reference(StrictModel):
    env: str = Field(min_length=1, max_length=128, pattern=r'^[A-Za-z_][A-Za-z0-9_]*$')
    secret: bool | None = None


class HeaderReference(Reference):
    prefix: Literal['', 'Bearer '] = ''


class ServerConfig(StrictModel):
    id: str
    enabled: bool = False
    transport: Literal['stdio', 'http']
    command: str | None = None
    args: list[str] = Field(default_factory=list, max_length=128)
    url: str | None = None
    env: dict[str, Reference] = Field(default_factory=dict)
    headers: dict[str, HeaderReference] = Field(default_factory=dict)
    readOnlyTools: list[str] = Field(default_factory=list, max_length=2048)


class SkillMetadata(StrictModel):
    id: str = Field(min_length=1, max_length=64, pattern=r'^[A-Za-z0-9][A-Za-z0-9_-]*$')
    name: str = Field(min_length=1, max_length=256)
    description: str = Field(min_length=1, max_length=4096)
    tools: list[str] = Field(default_factory=list, max_length=256)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')


def alias(server_id, tool_name):
    candidate = f'{server_id}__{tool_name}'
    if SAFE_NAME.fullmatch(candidate):
        return candidate
    return 'tool_' + hashlib.sha256((server_id + '\0' + tool_name).encode()).hexdigest()[:48]


def local_endpoint(value):
    if not isinstance(value, str) or len(value) > 2048 or any(ord(c) < 32 for c in value):
        raise ExtensionError('EXTENSION_CONFIG_INVALID')
    u = urlsplit(value)
    if (not u.hostname or u.username or u.password or '?' in value or '#' in value or
            not (u.scheme == 'https' or (u.scheme == 'http' and u.hostname in {'127.0.0.1', 'localhost', '::1'}))):
        raise ExtensionError('EXTENSION_CONFIG_INVALID')
    _ = u.port
    return value


class Extensions:
    """Load local config once. Changes require a runtime restart, freezing each approval's meaning."""
    def __init__(self, root: Path | None, environment: dict[str, str] | None = None, secrets=()):
        self.root = root.resolve() if root else None
        self.environment = dict(environment or {})
        self.forbidden_credentials = {value for value in secrets if value}
        self.secrets = sorted(self.forbidden_credentials, key=len, reverse=True)
        self.limits = dict(DEFAULT_LIMITS)
        self.server_configs = {}
        self.servers = []
        self.skills = {}
        self.tools = {}
        self.error = None
        self.discovered = False
        self.lock = asyncio.Lock()
        try:
            self._load()
        except Exception as error:
            self.server_configs = {}
            self.servers = []
            self.skills = {}
            self.error = error.code if isinstance(error, ExtensionError) else 'EXTENSION_CONFIG_INVALID'

    def redact(self, value, fields=True):
        if isinstance(value, dict):
            return {str(k): '[REDACTED]' if fields and SECRET_FIELD.search(str(k)) else self.redact(v, fields) for k, v in value.items()}
        if isinstance(value, list):
            return [self.redact(v, fields) for v in value]
        if isinstance(value, str):
            for secret in self.secrets:
                value = value.replace(secret, '[REDACTED]')
            return value
        return value

    def contains_secret(self, value):
        """Structural values are never rewritten. Reject credential-bearing definitions instead."""
        if isinstance(value, dict):
            return any(self.contains_secret(key) or self.contains_secret(item) for key, item in value.items())
        if isinstance(value, list):
            return any(self.contains_secret(item) for item in value)
        return isinstance(value, str) and any(secret in value for secret in self.secrets)

    def register_references(self, server):
        refs = [(name, ref, False) for name, ref in server.env.items()]
        refs += [(name, ref, True) for name, ref in server.headers.items()]
        for name, ref, header in refs:
            # Headers are always sensitive. Explicit false supports ordinary settings whose
            # names happen to contain a credential word (for example TOKEN_LIMIT).
            if header and ref.secret is False:
                raise ExtensionError('EXTENSION_CONFIG_INVALID')
            sensitive = header or (ref.secret if ref.secret is not None else
                                   bool(SECRET_FIELD.search(name) or SECRET_FIELD.search(ref.env)))
            value = self.environment.get(ref.env)
            if sensitive and isinstance(value, str) and value:
                if len(value) < 8:
                    raise ExtensionError('EXTENSION_CONFIG_INVALID')
                self.secrets = sorted({*self.secrets, value}, key=len, reverse=True)

    def _inside(self, relative):
        p = Path(relative)
        if not self.root or p.is_absolute() or '..' in p.parts:
            raise ExtensionError('EXTENSION_CONFIG_INVALID')
        target = self.root / p
        if not target.resolve().is_relative_to(self.root):
            raise ExtensionError('EXTENSION_CONFIG_INVALID')
        return target

    def _load(self):
        if self.root is None:
            return
        config_path = self._inside('.agent/extensions.json')
        if not config_path.exists():
            return
        if config_path.stat().st_size > HARD_LIMITS['configBytes']:
            raise ExtensionError('EXTENSION_LIMIT_EXCEEDED')
        config = json.loads(config_path.read_text('utf-8'))
        if (not isinstance(config, dict) or (type(config.get('schemaVersion')) is not int or config['schemaVersion'] != 1) or
                set(config) - {'schemaVersion', 'servers', 'skillDirectories', 'limits'}):
            raise ExtensionError('EXTENSION_CONFIG_INVALID')
        limits = config.get('limits', {})
        if not isinstance(limits, dict):
            raise ExtensionError('EXTENSION_CONFIG_INVALID')
        for key, value in limits.items():
            if key not in self.limits or type(value) is not int or not 1 <= value <= HARD_LIMITS[key]:
                raise ExtensionError('EXTENSION_CONFIG_INVALID')
            self.limits[key] = value
        if config_path.stat().st_size > self.limits['configBytes']:
            raise ExtensionError('EXTENSION_LIMIT_EXCEEDED')
        servers = config.get('servers', [])
        if not isinstance(servers, list) or len(servers) > self.limits['servers']:
            raise ExtensionError('EXTENSION_LIMIT_EXCEEDED')
        ids = set()
        for raw in servers:
            sid = raw.get('id') if isinstance(raw, dict) else None
            if not isinstance(sid, str) or not SERVER_ID.fullmatch(sid) or sid in ids:
                raise ExtensionError('EXTENSION_CONFIG_INVALID')
            ids.add(sid)
            try:
                server = ServerConfig(**raw)
                if server.transport == 'http':
                    local_endpoint(server.url)
                    if server.command or server.args or server.env:
                        raise ExtensionError('EXTENSION_CONFIG_INVALID')
                elif (not server.command or server.url or server.headers or
                      any(len(a) > 4096 or '\0' in a for a in server.args)):
                    raise ExtensionError('EXTENSION_CONFIG_INVALID')
                # Inline literals in env/headers are rejected by strict Reference schemas.
                self.register_references(server)
                self.server_configs[sid] = server
                self.servers.append({'id': sid, 'status': 'disabled' if not server.enabled else 'error',
                                     **({'error': 'MCP_SERVER_UNAVAILABLE'} if server.enabled else {})})
            except Exception:
                self.servers.append({'id': sid, 'status': 'error', 'error': 'EXTENSION_CONFIG_INVALID'})
        if any(self.contains_secret(state['id']) for state in self.servers):
            raise ExtensionError('EXTENSION_CONFIG_INVALID')
        directories = config.get('skillDirectories', ['skills', '.agent/skills'])
        if not isinstance(directories, list) or len(directories) > 32:
            raise ExtensionError('EXTENSION_CONFIG_INVALID')
        for directory in directories:
            target = self._inside(directory)
            if not target.exists():
                continue
            sources, entries = [], 0
            for walk_root, dirs, files in os.walk(target, followlinks=False):
                entries += len(dirs) + len(files)
                if entries > 10000:
                    raise ExtensionError('EXTENSION_LIMIT_EXCEEDED')
                for name in [*dirs, *files]:
                    child = Path(walk_root) / name
                    if child.is_symlink() and not child.resolve().is_relative_to(self.root):
                        raise ExtensionError('EXTENSION_CONFIG_INVALID')
                if 'SKILL.md' in files:
                    sources.append(Path(walk_root) / 'SKILL.md')
            for source in sorted(sources):
                if len(self.skills) >= self.limits['skills']:
                    raise ExtensionError('EXTENSION_LIMIT_EXCEEDED')
                if not source.resolve().is_relative_to(self.root):
                    raise ExtensionError('EXTENSION_CONFIG_INVALID')
                if source.stat().st_size > self.limits['skillBytes']:
                    raise ExtensionError('SKILL_TOO_LARGE')
                text = source.read_text('utf-8')
                if not text.startswith('---\n') or '\n---\n' not in text[4:]:
                    raise ExtensionError('EXTENSION_CONFIG_INVALID')
                front, body = text[4:].split('\n---\n', 1)
                metadata = SkillMetadata(**yaml.safe_load(front))
                if (metadata.id in self.skills or self.contains_secret([metadata.id, *metadata.tools])
                        or any(not SAFE_NAME.fullmatch(t) for t in metadata.tools)):
                    raise ExtensionError('EXTENSION_CONFIG_INVALID')
                self.skills[metadata.id] = {**metadata.model_dump(), 'name': self.redact(metadata.name),
                                            'description': self.redact(metadata.description), 'body': self.redact(body)}

    def reference(self, ref):
        if ref.env == 'MEETING_AGENT_API_KEY' or ref.env not in self.environment:
            raise ExtensionError('MCP_SERVER_UNAVAILABLE')
        value = self.environment[ref.env]
        if not isinstance(value, str) or not value or value in self.forbidden_credentials or '\0' in value or len(value) > 8192:
            raise ExtensionError('MCP_SERVER_UNAVAILABLE')
        return value

    @asynccontextmanager
    async def connection(self, server):
        async def ignore_log(*_args):
            pass
        if server.transport == 'stdio':
            command = sys.executable if server.command == '{runtimePython}' else server.command
            # SDK merges its safe inherited env; explicitly overwrite every key, then add references.
            env = {key: '' for key in DEFAULT_INHERITED_ENV_VARS}
            env['PATH'] = os.defpath
            env.update({key: self.reference(ref) for key, ref in server.env.items()})
            if any(not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key) for key in env):
                raise ExtensionError('EXTENSION_CONFIG_INVALID')
            params = StdioServerParameters(command=command, args=server.args, env=env, cwd=self.root)
            with open(os.devnull, 'w') as errlog:
                async with Client(stdio_client(params, errlog=errlog), logging_callback=ignore_log,
                                  read_timeout_seconds=self.limits['toolTimeout']) as client:
                    yield client
        else:
            headers = {name: ref.prefix + self.reference(ref) for name, ref in server.headers.items()}
            async with httpx2.AsyncClient(headers=headers, trust_env=False, follow_redirects=False,
                                          timeout=self.limits['toolTimeout']) as http:
                async with Client(streamable_http_client(server.url, http_client=http,
                                      max_sse_event_size=self.limits['resultBytes']),
                                  logging_callback=ignore_log,
                                  read_timeout_seconds=self.limits['toolTimeout']) as client:
                    yield client

    async def _listing(self, client):
        tools, cursors = [], set()
        cursor = None
        while True:
            page = await client.list_tools(cursor=cursor)
            tools.extend(page.tools)
            if len(tools) > self.limits['tools']:
                raise ExtensionError('EXTENSION_LIMIT_EXCEEDED')
            cursor = page.next_cursor
            if not cursor:
                return tools
            if cursor in cursors or len(cursors) >= self.limits['tools']:
                raise ExtensionError('EXTENSION_LIMIT_EXCEEDED')
            cursors.add(cursor)

    async def discover(self):
        async with self.lock:
            if self.discovered:
                return
            async def one(state):
                server = self.server_configs.get(state['id'])
                if not server or not server.enabled:
                    return
                try:
                    async with asyncio.timeout(self.limits['discoveryTimeout']):
                        async with self.connection(server) as client:
                            listing = await self._listing(client)
                    found = {}
                    for tool in listing:
                        if UNSAFE_TOOL.search(tool.name):
                            continue
                        if len(tool.description or tool.name) > 16384:
                            raise ExtensionError('EXTENSION_LIMIT_EXCEEDED')
                        schema = tool.input_schema
                        if self.contains_secret([schema, tool.name, alias(server.id, tool.name)]):
                            raise ExtensionError('EXTENSION_CONFIG_INVALID')
                        if len(encoded(schema)) > self.limits['schemaBytes']:
                            raise ExtensionError('EXTENSION_LIMIT_EXCEEDED')
                        validator = validators.validator_for(schema)
                        validator.check_schema(schema)
                        # Remote references are never fetched during argument validation.
                        if self._external_refs(schema):
                            raise ExtensionError('EXTENSION_CONFIG_INVALID')
                        name = alias(server.id, tool.name)
                        if name in found or name in self.tools:
                            raise ExtensionError('EXTENSION_CONFIG_INVALID')
                        found[name] = {'name': name, 'original': tool.name, 'serverId': server.id,
                                      'description': self.redact(tool.description or tool.name),
                                      'schema': schema,
                                      'effect': 'read' if tool.name in server.readOnlyTools else 'write'}
                    if len(self.tools) + len(found) > self.limits['tools']:
                        raise ExtensionError('EXTENSION_LIMIT_EXCEEDED')
                    self.tools.update(found)
                    state.clear()
                    state.update(id=server.id, status='ready')
                except Exception as error:
                    state.update(status='error', error=fixed_error(error, 'MCP_SERVER_UNAVAILABLE'))
            await asyncio.gather(*(one(state) for state in self.servers))
            self.discovered = True

    @staticmethod
    def _external_refs(value):
        if isinstance(value, dict):
            return any((key in {'$ref', '$dynamicRef', '$recursiveRef'} and (not isinstance(item, str) or not item.startswith('#')))
                       or Extensions._external_refs(item) for key, item in value.items())
        return isinstance(value, list) and any(Extensions._external_refs(item) for item in value)

    def available(self, skill):
        return all(name in self.tools for name in skill['tools']) and not self.error

    async def catalog(self):
        await self.discover()
        public = {'skills': [{key: skill[key] for key in ('id', 'name', 'description', 'tools')}
                             | {'available': bool(self.available(skill))} for skill in self.skills.values()],
                  'tools': [{key: tool[key] for key in ('name', 'description', 'serverId', 'effect')}
                            for tool in self.tools.values()], 'servers': self.servers,
                  **({'error': self.error} if self.error else {})}
        return {'revision': hashlib.sha256(encoded(public)).hexdigest(), **public}

    async def select(self, ids):
        if not ids:
            return [], {}
        await self.discover()
        if self.error:
            raise ExtensionError(self.error)
        selected = []
        for sid in dict.fromkeys(ids):
            if sid not in self.skills:
                raise ExtensionError('SKILL_NOT_FOUND')
            skill = self.skills[sid]
            if not self.available(skill):
                raise ExtensionError('SKILL_UNAVAILABLE')
            selected.append(skill)
        names = {name for skill in selected for name in skill['tools']}
        return selected, {name: self.tools[name] for name in sorted(names)}

    def validate_arguments(self, tool, arguments):
        if not isinstance(arguments, dict) or len(encoded(arguments)) > self.limits['argumentsBytes']:
            raise ExtensionError('TOOL_ARGUMENTS_INVALID')
        try:
            validators.validator_for(tool['schema'])(tool['schema']).validate(arguments)
        except Exception:
            raise ExtensionError('TOOL_ARGUMENTS_INVALID') from None

    async def call(self, tool, arguments):
        try:
            async with asyncio.timeout(self.limits['toolTimeout']):
                server = self.server_configs[tool['serverId']]
                async with self.connection(server) as client:
                    # List on the fresh session to bind current schema, but NEVER auto-retry a call.
                    listing = await self._listing(client)
                    current = next((t for t in listing if t.name == tool['original']), None)
                    if not current or current.input_schema != tool['schema']:
                        raise ExtensionError('TOOL_ARGUMENTS_INVALID')
                    result = await client.session.call_tool(tool['original'], arguments)
                    if result.is_error:
                        raise ExtensionError('MCP_TOOL_FAILED')
                    value = result.model_dump(mode='json', by_alias=True, exclude_none=True)
                    if len(encoded(value)) > self.limits['resultBytes']:
                        raise ExtensionError('TOOL_RESULT_TOO_LARGE')
                    return self.redact(value)
        except TimeoutError:
            raise ExtensionError('TOOL_TIMEOUT') from None
        except ExtensionError:
            raise
        except Exception as error:
            raise ExtensionError(fixed_error(error, 'MCP_TOOL_FAILED')) from None
