"""Real provider HTTP and MCP subprocess/HTTP integration tests."""
import json
import os
import socket
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4

import httpx
import pytest

from meeting_runtime.app import CAPABILITY, REVISION
from meeting_runtime.extensions import Extensions, alias

ADAPTER = Path(__file__).parent / 'fixtures/mcp_adapter.py'
SOURCE = Path(__file__).parents[1] / 'src'


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def wait_until(operation, timeout=15):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = operation()
        if value:
            return value
        time.sleep(.03)
    raise AssertionError('condition timed out')


class Model:
    def __init__(self):
        self.requests = []
        self.mode = 'lookup'
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                outer.requests.append(data)
                mode = outer.mode
                if mode == 'delay':
                    time.sleep(.5)
                    mode = 'plain'
                if data['messages'][-1]['role'] == 'tool' and mode != 'loop':
                    reply = {'content': 'final meeting answer'}
                elif mode == 'plain':
                    reply = {'content': 'plain meeting answer'}
                else:
                    names = {'lookup': 'lookup', 'write': 'publish', 'invalid': 'lookup',
                             'unknown': 'not_configured', 'loop': 'lookup', 'slow': 'slow', 'version': 'lookup_v1',
                             'large': 'large', 'broken': 'broken', 'credential': 'publish'}
                    name = names[mode]
                    arguments = {'query': 'meeting reference'}
                    if mode == 'version':
                        arguments = {'version': 'v1'}
                    elif mode == 'write':
                        arguments = {'title': 'meeting draft'}
                    elif mode == 'invalid':
                        arguments = {'query': 42}
                    elif mode == 'slow':
                        arguments = {'seconds': 5}
                    elif mode == 'large':
                        arguments = {'size': 10000}
                    elif mode == 'credential':
                        arguments = {'title': 'adapter-secret-value'}
                    reply = {'content': None, 'tool_calls': [{'id': 'call-' + str(len(outer.requests)),
                        'type': 'function', 'function': {'name': 'office__' + name, 'arguments': json.dumps(arguments)}}]}
                payload = json.dumps({'choices': [{'message': reply}]}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        self.http = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=2)


class Runtime:
    def __init__(self, root, model):
        self.root = root
        self.model = model
        self.process = None
        self.client = None
        self.start()

    def start(self):
        endpoint = port()
        environment = {key: value for key, value in os.environ.items() if key in {'PATH', 'HOME', 'TMPDIR', 'LANG'}}
        environment.update(PYTHONPATH=str(SOURCE), PYTHONDONTWRITEBYTECODE='1', UNRELATED_SECRET='ambient-secret',
                           MEETING_AGENT_API_KEY='ambient-model-secret')
        self.process = subprocess.Popen([sys.executable, '-m', 'meeting_runtime'], env=environment,
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        config = {'schemaVersion': 'meeting-runtime.v1', 'port': endpoint, 'bearerToken': 'test-bearer-' * 5,
            'dataRoot': str(self.root / 'data'), 'projectRoot': str(self.root), 'exitOnStdinClose': True,
            'integrationEnvironment': {'SRC_COUNT': str(self.root / 'calls.txt'), 'SRC_PID': str(self.root / 'pids.txt'),
                                       'SRC_TOKEN': 'adapter-secret-value', 'DEBUG': '1', 'PORT': '80'},
            'model': {'apiBase': f'http://127.0.0.1:{self.model.http.server_port}/v1',
                      'apiKey': 'provider-secret-value', 'model': 'configured-model'}}
        self.process.stdin.write((json.dumps(config) + '\n').encode())
        self.process.stdin.flush()
        self.client = httpx.Client(base_url=f'http://127.0.0.1:{endpoint}',
                                   headers={'Authorization': 'Bearer ' + config['bearerToken']}, timeout=15, trust_env=False)
        def healthy():
            try:

                response = self.client.get('/v1/health')
                if not response.is_success:
                    raise AssertionError(str(response.status_code) + ': ' + response.text)
                return True
            except httpx.HTTPError:
                if self.process.poll() is not None:
                    raise AssertionError(self.process.stderr.read().decode())
                return False
        wait_until(healthy)
        self.thread = self.client.post('/v1/threads', json={'workspaceRoot': '/opaque/test'}).json()['id']

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.stdin.close()
            self.process.wait(timeout=15)
        if self.client:
            self.client.close()
        if self.process:
            assert self.process.returncode == 0, self.process.stderr.read().decode()
            self.process.stderr.close()

    @contextmanager
    def run(self, skills=('meeting-skill',)):
        body = {'requestId': str(uuid4()), 'message': 'meeting question', 'modelProfileId': 'meeting-model',
                'catalogRevision': REVISION, 'capabilityRevision': CAPABILITY, 'extensionSkillIds': list(skills)}
        with self.client.stream('POST', f'/v1/threads/{self.thread}/runs/stream', json=body) as response:
            if not response.is_success:
                response.read()
                raise AssertionError(response.text)
            rid = response.headers['x-meeting-agent-run-id']
            yield rid, response

    def record(self, rid):
        return self.client.get(f'/v1/threads/{self.thread}/runs/{rid}').json()

    def events(self, rid):
        return self.client.get(f'/v1/threads/{self.thread}/runs/{rid}/events').json()['events']

    def terminal(self, rid):
        return wait_until(lambda: self.record(rid) if self.record(rid)['status'] in {'completed', 'failed', 'cancelled'} else None)

    def approval(self, rid):
        return wait_until(lambda: next((e['data'] for e in self.events(rid) if e['event'] == 'tool_approval'), None))

    def decide(self, rid, approval, decision):
        return self.client.post(f'/v1/threads/{self.thread}/runs/{rid}/approvals/{approval["approvalId"]}',
                                json={'decision': decision})

    def count(self):
        target = self.root / 'calls.txt'
        return len(target.read_text().splitlines()) if target.exists() else 0


def write_config(root, transport='stdio', limits=None, http_port=None):
    (root / '.agent').mkdir(exist_ok=True)
    server = {'id': 'office', 'enabled': True, 'transport': transport,
              'readOnlyTools': ['lookup', 'lookup_v1', 'slow', 'large', 'broken']}
    if transport == 'stdio':
        server.update(command='{runtimePython}', args=[str(ADAPTER)], env={
            'COUNT_FILE': {'env': 'SRC_COUNT'}, 'PID_FILE': {'env': 'SRC_PID'}, 'ADAPTER_TOKEN': {'env': 'SRC_TOKEN'}, 'DEBUG': {'env': 'DEBUG'}, 'PORT': {'env': 'PORT'}})
    else:
        server.update(url=f'http://127.0.0.1:{http_port}/mcp', headers={'X-Test-Auth': {'env': 'SRC_TOKEN', 'prefix': 'Bearer '}})
    config = {'schemaVersion': 1, 'servers': [server], 'limits': limits or {}}
    (root / '.agent/extensions.json').write_text(json.dumps(config))
    skill = root / 'skills/meeting'
    skill.mkdir(parents=True, exist_ok=True)
    (skill / 'SKILL.md').write_text('''---
id: meeting-skill
name: Meeting workflow
description: Read reference material and publish approved drafts.
tools: [office__lookup, office__publish, office__slow, office__large, office__broken, office__lookup_v1]
---
SKILL_BODY_MARKER: Read the reference then draft the meeting response.
''')
    return config


@pytest.fixture
def integration(tmp_path):
    write_config(tmp_path)
    model = Model()
    runtime = Runtime(tmp_path, model)
    try:
        yield runtime, model
    finally:
        runtime.stop()
        model.close()
        pids = tmp_path / 'pids.txt'
        if pids.exists():
            for pid in map(int, pids.read_text().splitlines()):
                with pytest.raises(ProcessLookupError):
                    os.kill(pid, 0)


def test_stdio_read_skill_instruction_and_secrets(integration):
    runtime, model = integration
    catalog = runtime.client.get('/v1/extensions').json()
    assert catalog['servers'] == [{'id': 'office', 'status': 'ready'}]
    assert catalog['skills'][0]['available'] is True
    assert all(tool['name'] != 'office__shell' for tool in catalog['tools'])
    assert next(t for t in catalog['tools'] if t['name'] == 'office__publish')['effect'] == 'write'
    with runtime.run() as (rid, response):
        assert runtime.terminal(rid)['status'] == 'completed'
        response.read()
        assert 'final meeting answer' in response.text
        assert 'requestId' in response.text
        assert 'adapter-secret-value' not in response.text
    assert 'SKILL_BODY_MARKER' in model.requests[0]['messages'][0]['content']
    assert model.requests[1]['messages'][-1]['role'] == 'tool'
    assert 'adapter-secret-value' not in json.dumps(model.requests)
    result = json.loads(model.requests[1]['messages'][-1]['content'])
    text = result['content'][0]['text']
    assert 'ambient-secret' not in text and 'ambient-model-secret' not in text
    assert '[REDACTED]' in text
    assert 'inputSchema' not in json.dumps(catalog) and 'schema' not in json.dumps(catalog)
    audit = runtime.client.get(f'/v1/threads/{runtime.thread}/runs/{rid}/tool-calls').json()
    assert audit['toolCalls'][0]['status'] == 'completed'
    assert runtime.count() == 0


def test_write_requires_single_exact_approval(integration):
    runtime, model = integration
    model.mode = 'write'
    with runtime.run() as (rid, response):
        approval = runtime.approval(rid)
        assert runtime.record(rid)['status'] == 'waiting_approval'
        assert runtime.count() == 0
        wrong = runtime.client.post(f'/v1/threads/{uuid4()}/runs/{rid}/approvals/{approval["approvalId"]}', json={'decision': 'approve'})
        assert wrong.status_code == 404
        assert runtime.decide(rid, approval, 'approve').is_success
        assert runtime.decide(rid, approval, 'approve').status_code == 409
        assert runtime.terminal(rid)['status'] == 'completed'
        assert runtime.count() == 1
        response.read()
    tool_events = [e for e in runtime.events(rid) if e['event'] in {'tool_approval', 'tool_start', 'tool_result'}]
    assert {e['data']['callId'] for e in tool_events} == {approval['callId']}
    assert len([e for e in tool_events if e['event'] == 'tool_start']) == 1


@pytest.mark.parametrize('decision', ['deny', 'cancel', 'restart'])
def test_pending_write_never_dispatches_on_deny_cancel_or_restart(integration, decision):
    runtime, model = integration
    model.mode = 'write'
    with runtime.run() as (rid, response):
        approval = runtime.approval(rid)
        assert runtime.count() == 0
        if decision == 'deny':
            assert runtime.decide(rid, approval, 'deny').is_success
            assert runtime.terminal(rid)['status'] == 'completed'
            assert model.requests[-1]['messages'][-1]['role'] == 'tool'
            assert 'executed' in model.requests[-1]['messages'][-1]['content']
        elif decision == 'cancel':
            result = runtime.client.post(f'/v1/threads/{runtime.thread}/runs/{rid}/cancel').json()
            assert result['cancelled'] is True
            assert runtime.decide(rid, approval, 'approve').status_code == 409
        else:
            runtime.process.kill()
            runtime.process.wait(timeout=5)
            runtime.client.close()
            runtime.process.stderr.close()
            runtime.start()
            assert runtime.record(rid)['status'] == 'interrupted'
            assert runtime.decide(rid, approval, 'approve').status_code == 409
        assert runtime.count() == 0


@pytest.mark.parametrize(('mode', 'code'), [('invalid', 'TOOL_ARGUMENTS_INVALID'), ('unknown', 'TOOL_NOT_ALLOWED'), ('broken', 'MCP_TOOL_FAILED')])
def test_invalid_unknown_and_failure_do_not_dispatch_write(integration, mode, code):
    runtime, model = integration
    model.mode = mode
    with runtime.run() as (rid, response):
        assert runtime.terminal(rid)['status'] == 'failed'
        response.read()
        assert code in response.text
        assert 'sensitive-adapter-error' not in response.text
    assert runtime.count() == 0


def test_no_skill_no_tools_and_unknown_skill(integration):
    runtime, model = integration
    model.mode = 'plain'
    with runtime.run(()) as (rid, _response):
        assert runtime.terminal(rid)['status'] == 'completed'
    assert 'tools' not in model.requests[0]
    assert 'SKILL_BODY_MARKER' not in model.requests[0]['messages'][0]['content']
    with pytest.raises(AssertionError, match='SKILL_NOT_FOUND'):
        with runtime.run(('missing',)):
            pass


@pytest.mark.parametrize(('mode', 'limits', 'code'), [
    ('loop', {'toolRounds': 1}, 'TOOL_CALL_LIMIT_EXCEEDED'),
    ('large', {'resultBytes': 1024}, 'TOOL_RESULT_TOO_LARGE'),
    ('slow', {'toolTimeout': 1}, 'TOOL_TIMEOUT'),
    ('write', {'approvalTimeout': 1}, 'TOOL_APPROVAL_TIMEOUT'),
])
def test_explicit_limits(integration, mode, limits, code):
    runtime, model = integration
    runtime.stop()
    write_config(runtime.root, limits=limits)
    runtime.start()
    model.mode = mode
    with runtime.run() as (rid, response):
        assert runtime.terminal(rid)['status'] == 'failed'
        response.read()
        assert code in response.text
    assert runtime.count() == 0


def test_http_real_handshake_and_tool(integration):
    runtime, model = integration
    runtime.stop()
    http_port = port()
    child = subprocess.Popen([sys.executable, str(ADAPTER), '--http', str(http_port)],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             env={'PATH': os.defpath, 'ADAPTER_TOKEN': 'adapter-secret-value'})
    def listening():
        with socket.socket() as sock:
            return sock.connect_ex(('127.0.0.1', http_port)) == 0
    try:
        wait_until(listening)
        write_config(runtime.root, transport='http', http_port=http_port)
        runtime.start()
        assert runtime.client.get('/v1/extensions').json()['servers'][0]['status'] == 'ready'
        with runtime.run() as (rid, _response):
            assert runtime.terminal(rid)['status'] == 'completed'
    finally:
        child.terminate()
        child.wait(timeout=10)


def test_bad_or_missing_configuration_keeps_plain_chat(integration):
    runtime, model = integration
    runtime.stop()
    (runtime.root / '.agent/extensions.json').write_text('{bad json')
    runtime.start()
    assert runtime.client.get('/v1/extensions').json()['error'] == 'EXTENSION_CONFIG_INVALID'
    model.mode = 'plain'
    with runtime.run(()) as (rid, _response):
        assert runtime.terminal(rid)['status'] == 'completed'
    runtime.stop()
    (runtime.root / '.agent/extensions.json').unlink()
    runtime.start()
    assert runtime.client.get('/v1/extensions').json()['skills'] == []


def test_disabled_missing_environment_and_unavailable_skill(integration):
    runtime, _model = integration
    runtime.stop()
    config = write_config(runtime.root)
    config['servers'][0]['env']['ADAPTER_TOKEN']['env'] = 'MISSING'
    (runtime.root / '.agent/extensions.json').write_text(json.dumps(config))
    runtime.start()
    catalog = runtime.client.get('/v1/extensions').json()
    assert catalog['servers'][0]['status'] == 'error'
    assert catalog['skills'][0]['available'] is False
    with pytest.raises(AssertionError, match='SKILL_UNAVAILABLE'):
        with runtime.run():
            pass
    runtime.stop()
    config['servers'][0].pop('enabled')
    (runtime.root / '.agent/extensions.json').write_text(json.dumps(config))
    runtime.start()
    assert runtime.client.get('/v1/extensions').json()['servers'][0]['status'] == 'disabled'


def test_symlink_escape_and_safe_yaml(tmp_path):
    root = tmp_path / 'root'
    root.mkdir()
    write_config(root)
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'SKILL.md').write_text('not a skill')
    (root / 'skills/meeting/SKILL.md').unlink()
    (root / 'skills/meeting/SKILL.md').symlink_to(outside / 'SKILL.md')
    assert Extensions(root).error == 'EXTENSION_CONFIG_INVALID'
    (root / 'skills/meeting/SKILL.md').unlink()
    (root / 'skills/meeting/SKILL.md').write_text('---\n!!python/object/apply:os.system ["echo unsafe"]\n---\nbody')
    assert Extensions(root).error == 'EXTENSION_CONFIG_INVALID'
    assert alias('office', 'lookup') == 'office__lookup'
    assert alias('office', 'a' * 100) == alias('office', 'a' * 100)
    assert len(alias('office', 'a' * 100)) <= 64


def test_approval_metadata_redacts_known_credentials(integration):
    runtime, model = integration
    model.mode = 'credential'
    with runtime.run() as (rid, _response):
        approval = runtime.approval(rid)
        assert approval['arguments'] == {'title': '[REDACTED]'}
        assert approval['expiresAt'] > int(time.time() * 1000)
        audit = runtime.client.get(f'/v1/threads/{runtime.thread}/runs/{rid}/tool-calls').json()
        assert 'adapter-secret-value' not in json.dumps(audit)
        assert runtime.decide(rid, approval, 'deny').is_success
        assert runtime.terminal(rid)['status'] == 'completed'
    assert runtime.count() == 0
    assert 'adapter-secret-value' not in json.dumps(model.requests[-1])


def test_single_bad_server_does_not_hide_valid_server(integration):
    runtime, _model = integration
    runtime.stop()
    config = write_config(runtime.root)
    config['servers'].append({'id': 'bad', 'enabled': True, 'transport': 'stdio',
                              'command': '/does-not-exist', 'args': []})
    (runtime.root / '.agent/extensions.json').write_text(json.dumps(config))
    runtime.start()
    catalog = runtime.client.get('/v1/extensions').json()
    assert catalog['servers'][0]['status'] == 'ready'
    assert catalog['servers'][1]['status'] == 'error'
    assert catalog['skills'][0]['available'] is True


def test_discovery_timeout_reaps_stalled_subprocess(integration):
    runtime, model = integration
    runtime.stop()
    config = write_config(runtime.root, limits={'discoveryTimeout': 1})
    config['servers'][0]['args'] = ['-c', "import os,time;open(os.environ['PID_FILE'],'a').write(str(os.getpid())+'\\n');time.sleep(30)"]
    (runtime.root / '.agent/extensions.json').write_text(json.dumps(config))
    runtime.start()
    started = time.monotonic()
    catalog = runtime.client.get('/v1/extensions').json()
    assert catalog['servers'][0]['status'] == 'error'
    assert time.monotonic() - started < 10
    model.mode = 'plain'
    with runtime.run(()) as (rid, _response):
        assert runtime.terminal(rid)['status'] == 'completed'


@pytest.mark.parametrize('change', ['literal-env', 'literal-header', 'count', 'skill-size', 'remote-ref'])
def test_config_constraints_are_explicit(tmp_path, change):
    config = write_config(tmp_path)
    if change == 'literal-env':
        config['servers'][0]['env'] = {'TOKEN': 'inline-secret'}
    elif change == 'literal-header':
        config['servers'][0].update(transport='http', url='https://adapter.example/mcp',
                                   command=None, args=[], env={}, headers={'Authorization': 'inline-secret'})
    elif change == 'count':
        config['limits']['tools'] = 257
    elif change == 'skill-size':
        config['limits']['skillBytes'] = 1
    else:
        assert Extensions._external_refs({'$ref': 'https://example.invalid/schema'}) is True
        assert Extensions._external_refs({'$ref': '#/$defs/local'}) is False
        return
    (tmp_path / '.agent/extensions.json').write_text(json.dumps(config))
    extension = Extensions(tmp_path)
    if change in {'literal-env', 'literal-header'}:
        assert extension.servers[0]['status'] == 'error'
        assert extension.skills['meeting-skill']
    else:
        assert extension.error in {'EXTENSION_CONFIG_INVALID', 'SKILL_TOO_LARGE'}


def test_concurrent_discovery_cannot_admit_two_runs_in_one_thread(integration):
    from concurrent.futures import ThreadPoolExecutor
    runtime, model = integration
    model.mode = 'delay'
    barrier = threading.Barrier(2)
    def start():
        barrier.wait(timeout=5)
        body = {'requestId': str(uuid4()), 'message': 'meeting question', 'modelProfileId': 'meeting-model',
                'catalogRevision': REVISION, 'capabilityRevision': CAPABILITY,
                'extensionSkillIds': ['meeting-skill']}
        with httpx.Client(base_url=str(runtime.client.base_url), headers=dict(runtime.client.headers),
                          trust_env=False, timeout=15) as client:
            with client.stream('POST', f'/v1/threads/{runtime.thread}/runs/stream', json=body) as response:
                return response.status_code, response.headers.get('x-meeting-agent-run-id')
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _n: start(), range(2)))
    assert sorted(status for status, _rid in results) == [200, 409]
    rid = next(rid for status, rid in results if status == 200)
    assert runtime.terminal(rid)['status'] == 'completed'


def test_plain_environment_values_preserve_protocol_structures():
    extensions = Extensions(None, {'DEBUG': '1', 'PORT': '80', 'UNUSED': 'v1'})
    value = {'id': '12345678-1234-1234-1234-123456789080', 'name': 'office__lookup_v1',
             'schema': {'type': 'object', 'properties': {'version': {'enum': ['v1', '80']}}}}
    assert extensions.redact(value) == value


def test_plain_environment_preserves_real_catalog_schema_and_audit(integration):
    from uuid import UUID
    runtime, model = integration
    catalog = runtime.client.get('/v1/extensions').json()
    assert catalog['servers'][0]['status'] == 'ready'
    assert any(t['name'] == 'office__lookup_v1' for t in catalog['tools'])
    assert 'office__lookup_v1' in catalog['skills'][0]['tools']
    model.mode = 'version'
    with runtime.run() as (rid, _response):
        assert runtime.terminal(rid)['status'] == 'completed'
    definition = next(t for t in model.requests[0]['tools'] if t['function']['name'] == 'office__lookup_v1')
    assert definition['function']['parameters']['properties']['version']['enum'] == ['v1', '80']
    assert 'v1:80' in model.requests[1]['messages'][-1]['content']
    calls = runtime.client.get(f'/v1/threads/{runtime.thread}/runs/{rid}/tool-calls').json()['toolCalls']
    assert calls[0]['runId'] == rid
    assert calls[0]['threadId'] == runtime.thread
    assert calls[0]['toolName'] == 'office__lookup_v1'
    assert str(UUID(calls[0]['id'])) == calls[0]['id']
    assert calls[0]['arguments'] == {'version': 'v1'}
    start = next(e for e in runtime.events(rid) if e['event'] == 'tool_start')
    assert start['data']['callId'] == calls[0]['id']


@pytest.mark.parametrize('kind', ['inferred-target', 'inferred-source', 'explicit', 'header'])
def test_credential_references_are_semantic_and_short_credentials_rejected(tmp_path, kind):
    config = write_config(tmp_path)
    server = config['servers'][0]
    server['env'] = {}
    if kind == 'inferred-target':
        server['env']['API_KEY'] = {'env': 'VALUE'}
    elif kind == 'inferred-source':
        server['env']['CUSTOM_VALUE'] = {'env': 'SOURCE_PASSWORD'}
    elif kind == 'explicit':
        server['env']['CUSTOM_VALUE'] = {'env': 'VALUE', 'secret': True}
    else:
        server.update(transport='http', url='https://adapter.example/mcp', command=None,
                      args=[], headers={'X-Adapter-Custom': {'env': 'VALUE'}})
    (tmp_path / '.agent/extensions.json').write_text(json.dumps(config))
    source = 'SOURCE_PASSWORD' if kind == 'inferred-source' else 'VALUE'
    extension = Extensions(tmp_path, {source: '1'})
    assert extension.servers[0] == {'id': 'office', 'status': 'error', 'error': 'EXTENSION_CONFIG_INVALID'}
    extension = Extensions(tmp_path, {source: 'actual-sensitive-value'})
    assert extension.error is None
    assert extension.redact('echo actual-sensitive-value') == 'echo [REDACTED]'
    assert extension.contains_secret({'enum': ['actual-sensitive-value']}) is True
    assert extension.contains_secret({'enum': ['v1', '80']}) is False


def test_explicit_nonsecret_override_and_headers_cannot_opt_out(tmp_path):
    config = write_config(tmp_path)
    config['servers'][0]['env'] = {'TOKEN_LIMIT': {'env': 'VALUE', 'secret': False}}
    (tmp_path / '.agent/extensions.json').write_text(json.dumps(config))
    extension = Extensions(tmp_path, {'VALUE': '1'})
    assert extension.server_configs['office']
    assert extension.redact('v1') == 'v1'
    config['servers'][0].update(transport='http', url='https://adapter.example/mcp', command=None,
        args=[], env={}, headers={'X-Mode': {'env': 'VALUE', 'secret': False}})
    (tmp_path / '.agent/extensions.json').write_text(json.dumps(config))
    assert Extensions(tmp_path, {'VALUE': '1'}).servers[0]['status'] == 'error'


def test_credential_in_schema_is_rejected_instead_of_rewritten(integration):
    runtime, _model = integration
    runtime.stop()
    config = write_config(runtime.root)
    config['servers'][0]['env']['LEAK_SCHEMA'] = {'env': 'DEBUG'}
    (runtime.root / '.agent/extensions.json').write_text(json.dumps(config))
    runtime.start()
    catalog = runtime.client.get('/v1/extensions').json()
    assert catalog['servers'][0] == {'id': 'office', 'status': 'error', 'error': 'EXTENSION_CONFIG_INVALID'}
    assert catalog['tools'] == []
    assert 'adapter-secret-value' not in json.dumps(catalog)
