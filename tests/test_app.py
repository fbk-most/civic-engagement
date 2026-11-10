import logging

from fastapi.testclient import TestClient

from civic_engagement.app import create_app
from civic_engagement.config import SITE, cgroup_quota, cpus, memory, release_memory
from civic_engagement.domain import active_pack
from civic_engagement.fields import ComputeCache
from civic_engagement.serve import QuietPolls, log_config


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


def test_memory_released_and_logged_after_each_computation(caplog):
    release_memory()  # glibc or not, never fails
    cache: ComputeCache[int] = ComputeCache(2, 1, name="field")
    with caplog.at_level(logging.INFO, logger="civic_engagement.fields"):
        assert cache.get("a", lambda: 1) == 1
        assert cache.get("a", lambda: 2) == 1  # kept: computed once
    lines = [r.getMessage() for r in caplog.records]
    assert len(lines) == 1 and lines[0].startswith("field computed in") and "(1 kept); memory (MiB): container anon" in lines[0]
