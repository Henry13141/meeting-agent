from meeting_asr.__main__ import is_loopback_host


def test_only_loopback_hosts_are_allowed() -> None:
    assert is_loopback_host("127.0.0.1")
    assert is_loopback_host("::1")
    assert is_loopback_host("localhost")
    assert not is_loopback_host("0.0.0.0")
    assert not is_loopback_host("192.168.1.20")
    assert not is_loopback_host("asr.example.com")
