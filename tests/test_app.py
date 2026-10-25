from fastapi.testclient import TestClient

from civic_engagement.app import create_app
from civic_engagement.config import SITE, cgroup_quota, cpus
from civic_engagement.domain import active_pack


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
