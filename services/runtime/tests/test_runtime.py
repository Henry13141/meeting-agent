from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from meeting_runtime.app import CAPABILITY, REVISION, ModelConfig, create_app


def request(**overrides):
    return {'requestId': str(uuid4()), 'message': 'meeting evidence',
            'modelProfileId': 'meeting-model', 'catalogRevision': REVISION,
            'capabilityRevision': CAPABILITY, **overrides}


def test_no_model_auth_and_no_tools(tmp_path):
    with TestClient(create_app(tmp_path, 'test-secret', None)) as client:
        assert client.get('/v1/health').status_code == 401
        client.headers['Authorization'] = 'Bearer test-secret'
        assert client.get('/v1/health').json()['modelReady'] is False
        assert client.get('/v1/models').json()['profiles'][0]['enabled'] is False
        tid = client.post('/v1/threads', json={'workspaceRoot': '/opaque/context'}).json()['id']
        route = f'/v1/threads/{tid}/runs/stream'
        assert client.post(route, json=request()).status_code == 503
        for field, value in [('fullAccess', True), ('mcpTools', ['shell']), ('workspaceReadAllowed', True),
                             ('accessMode', 'workspace'), ('tools', ['send'])]:
            assert client.post(route, json=request(**{field: value})).status_code == 422
        # Validation must not echo private prompt bodies.
        result = client.post(route, json=request(secret='private-key-and-prompt'))
        assert 'private-key-and-prompt' not in result.text
        assert client.get('/v1/control/model-credential').status_code == 404


@pytest.mark.parametrize('url', ['http://remote.example/v1', 'https://user:secret@example.com',
                                'https://example.com/?secret=1', 'https://example.com/#fragment',
                                'file:///tmp/socket', 'http://127.0.0.2/v1'])
def test_reject_invalid_endpoint(url):
    with pytest.raises(ValueError):
        ModelConfig(apiBase=url, model='configured-model')


@pytest.mark.parametrize('url', ['https://provider.example/v1', 'http://127.0.0.1:9000/v1',
                                'http://localhost:9000/v1', 'http://[::1]:9000/v1'])
def test_generic_endpoint_without_key(url):
    assert ModelConfig(apiBase=url, model='configured-model').apiKey == ''


def test_restart_marks_incomplete_run_interrupted(tmp_path):
    import json
    import sqlite3
    rid, tid, request_id = map(str, (uuid4(), uuid4(), uuid4()))
    with TestClient(create_app(tmp_path, 'secret', None)):
        pass
    record = {'id': rid, 'threadId': tid, 'requestId': request_id, 'status': 'running',
              'createdAt': 1, 'updatedAt': 1}
    with sqlite3.connect(tmp_path / 'meetings.sqlite3') as db:
        db.execute('INSERT INTO runs VALUES (?,?,?,?,?,NULL)',
                   (rid, tid, request_id, json.dumps(record), 'private meeting'))
    with TestClient(create_app(tmp_path, 'secret', None), headers={'Authorization': 'Bearer secret'}) as client:
        assert client.get(f'/v1/threads/{tid}/runs/{rid}').json()['status'] == 'interrupted'
        events = client.get(f'/v1/threads/{tid}/runs/{rid}/events').json()
        assert events['events'][0]['data'] == {'code': 'RUN_INTERRUPTED'}
        assert 'private meeting' not in str(events)


def test_provider_protocol_and_errors_are_safe(tmp_path):
    import json
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    seen = []

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            seen.append((payload, self.headers.get('Authorization'), self.path))
            question = payload['messages'][-1]['content']
            if question == 'provider-error':
                self.send_response(500)
                self.end_headers()
                self.wfile.write(b'raw-private-provider-secret')
                return
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            message = {'content': 'meeting answer'}
            if question == 'tool-attempt':
                message['tool_calls'] = [{'function': {'name': 'shell'}}]
            self.wfile.write(json.dumps({'choices': [{'message': message}]}).encode())

    provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    thread = threading.Thread(target=provider.serve_forever, daemon=True)
    thread.start()
    try:
        config = ModelConfig(apiBase=f'http://127.0.0.1:{provider.server_port}/v1', model='local-model')
        with TestClient(create_app(tmp_path, 'secret', config), headers={'Authorization': 'Bearer secret'}) as client:
            tid = client.post('/v1/threads', json={'workspaceRoot': '/opaque/context'}).json()['id']
            route = f'/v1/threads/{tid}/runs/stream'
            value = request()
            result = client.post(route, json=value)
            rid = result.headers['x-meeting-agent-run-id']
            events = [json.loads(line[6:]) for line in result.text.splitlines() if line.startswith('data: ')]
            assert all(event['requestId'] == value['requestId'] for event in events)
            assert events[-1]['event'] == 'final'
            assert events[-1]['data']['reply'] == 'meeting answer'
            assert client.get(f'/v1/threads/{tid}/runs/{rid}').json()['status'] == 'completed'
            assert seen[0][1] is None
            assert seen[0][2] == '/v1/chat/completions'
            assert set(seen[0][0]) == {'model', 'messages', 'stream'}
            for message, code in [('tool-attempt', 'TOOLS_UNAVAILABLE'), ('provider-error', 'MODEL_REQUEST_FAILED')]:
                result = client.post(route, json=request(message=message))
                assert code in result.text
                assert 'raw-private-provider-secret' not in result.text
                assert 'meeting answer' not in result.text
    finally:
        provider.shutdown()
        provider.server_close()
        thread.join(timeout=2)
