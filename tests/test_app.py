import logging

import pytest
from fastapi.testclient import TestClient

from civic_engagement.app import create_app
from civic_engagement.config import SITE, cgroup_quota, cpus, memory, release_memory
from civic_engagement.domain import active_pack
from civic_engagement.fields import ComputeCache
from civic_engagement.serve import STARTUP_FAILURE, QuietPolls, log_config, serve


def test_serves_the_built_frontend_beside_the_api(tmp_path):
    (tmp_path / "index.html").write_text("<html>app</html>")
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "index-abc123.js").write_text("// bundle")
    client = TestClient(create_app(active_pack(), frontend=tmp_path))

    page = client.get("/")
    assert page.text == "<html>app</html>" and page.headers["cache-control"] == "no-cache"
    bundle = client.get("/assets/index-abc123.js")
    assert bundle.status_code == 200 and "immutable" in bundle.headers["cache-control"]
    assert client.get("/api/health").json() == {"status": "ok", "site": SITE.site_id}
    assert client.get("/api/cards").status_code == 200
    assert client.get("/assets/missing.js").status_code == 404


def test_compressed_when_the_browser_accepts_it(tmp_path):
    (tmp_path / "index.html").write_text("<html>app</html>")
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "index-abc123.js").write_text("const x = 1;\n" * 2000)
    client = TestClient(create_app(active_pack(), frontend=tmp_path))

    bundle = client.get("/assets/index-abc123.js", headers={"Accept-Encoding": "gzip"})
    assert bundle.headers["content-encoding"] == "gzip" and bundle.text == "const x = 1;\n" * 2000
    assert "immutable" in bundle.headers["cache-control"]
    plain = client.get("/assets/index-abc123.js", headers={"Accept-Encoding": "identity"})
    assert "content-encoding" not in plain.headers
    # Too small to be worth it.
    assert "content-encoding" not in client.get("/api/health", headers={"Accept-Encoding": "gzip"}).headers


def test_without_a_frontend_only_the_api(monkeypatch):
    monkeypatch.delenv("CIVIC_ENGAGEMENT_FRONTEND", raising=False)
    client = TestClient(create_app(active_pack()))
    assert client.get("/api/health").status_code == 200
    assert client.get("/").status_code == 404


def test_cpus_from_the_quota(monkeypatch):
    assert cgroup_quota("max 100000") is None
    assert cgroup_quota("400000 100000\n") == 4
    assert cgroup_quota("50000 100000") == 1
    monkeypatch.setenv("CIVIC_ENGAGEMENT_CPUS", "3")
    assert cpus() == 3
    monkeypatch.delenv("CIVIC_ENGAGEMENT_CPUS")
    assert cpus() >= 1


def test_memory_from_the_cgroup(tmp_path):
    (tmp_path / "memory.max").write_text(f"{4 * 2**30}\n")
    (tmp_path / "memory.current").write_text(f"{3 * 2**30}\n")
    (tmp_path / "memory.stat").write_text(f"file 1000\nanon {2 * 2**30}\n")
    (tmp_path / "memory.events").write_text("low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\n")
    (tmp_path / "status").write_text("Name:\tpython\nVmHWM:\t 2097152 kB\nVmRSS:\t 1048576 kB\n")
    assert memory(str(tmp_path), str(tmp_path / "status")) == {
        "limit_mib": 4096.0,
        "used_mib": 3072.0,
        "anon_mib": 2048.0,
        "peak_mib": None,
        "oom_kills": 1,
        "process_mib": 1024.0,
        "process_peak_mib": 2048.0,
    }
    (tmp_path / "memory.max").write_text("max\n")
    assert memory(str(tmp_path), str(tmp_path / "missing"))["limit_mib"] is None


def test_the_polls_left_out_of_the_access_log():
    def access(path: str) -> logging.LogRecord:
        args = ("10.0.0.1:5000", "GET", path, "1.1", 200)
        return logging.LogRecord("uvicorn.access", logging.INFO, "", 0, '%s - "%s %s HTTP/%s" %d', args, None)

    quiet = QuietPolls()
    assert not quiet.filter(access("/api/session/revision"))
    assert quiet.filter(access("/api/scene?t=3"))
    config = log_config()
    assert config["handlers"]["access"]["filters"] == ["quiet_polls"]
    assert config["loggers"]["civic_engagement"]["level"] == "INFO"


def test_the_exits_of_the_launcher(monkeypatch):
    import signal

    import uvicorn

    from civic_engagement.digitalhub import CredentialsUnavailable

    class Config:
        def __init__(self, error=None):
            self.error = error

        def load_app(self):
            if self.error:
                raise self.error

    # Credentials refused for good: status 3, not a traceback.
    assert serve(Config(CredentialsUnavailable("400"))) == STARTUP_FAILURE

    class Server:
        """uvicorn's server, shut down by a SIGTERM; sending it again to
        itself refused, as in some containers."""

        def __init__(self, config):
            self.should_exit, self.started, self._captured_signals = False, True, []

        def run(self):
            self.should_exit = True
            self._captured_signals.append(signal.SIGTERM)
            raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(uvicorn, "Server", Server)
    assert serve(Config()) == 143

    class Failing(Server):
        def run(self):  # a PermissionError of its own, no signal
            raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(uvicorn, "Server", Failing)
    with pytest.raises(PermissionError):
        serve(Config())


def test_memory_released_and_logged_after_each_computation(caplog):
    release_memory()  # glibc or not, never fails
    cache: ComputeCache[int] = ComputeCache(2, 1, name="field")
    with caplog.at_level(logging.INFO, logger="civic_engagement.fields"):
        assert cache.get("a", lambda: 1) == 1
        assert cache.get("a", lambda: 2) == 1  # kept: computed once
    lines = [r.getMessage() for r in caplog.records]
    assert len(lines) == 1 and lines[0].startswith("field computed in") and "(1 kept); memory (MiB): container anon" in lines[0]
