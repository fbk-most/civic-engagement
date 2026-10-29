import base64
import json

import pytest
from fastapi.testclient import TestClient

from civic_engagement import access, config
from civic_engagement.app import create_app
from civic_engagement.domain import active_pack
from civic_engagement.pins import DigitPin, PinFormat, checked
from civic_engagement.store import state, storage
from civic_engagement.store.storage import LocalStorage, Retrying
from civic_engagement.store.teams import TeamError, TeamStore

BENCH = {"card_type": "add_bench", "geometry": {"type": "Point", "coordinates": [11.002, 46.001]}, "params": {}}
SECRET = "a-secret-of-sixteen-or-more"


# PINs and the team store.


class TinyPin(DigitPin):
    def __init__(self) -> None:
        super().__init__(2)


class LetterPin(PinFormat):
    """A letter and 6 digits, the letter distinct: "b-123456"."""

    example, size = "b123456", 26 * 10**6

    def __init__(self, letters: str = "abcdefghijklmnopqrstuvwxyz") -> None:
        self.letters = letters

    def generate(self, taken: set[str]) -> str:
        free = [c for c in self.letters if c not in taken]
        if not free:
            raise ValueError("every letter taken")
        letter = free[0]
        return f"{letter.upper()}-{DigitPin().generate(set())}"

    def normalise(self, text: str) -> str:
        return "".join(c for c in text.lower() if c.isalnum())

    def distinct(self, pin: str) -> str:
        return pin[:1]


def test_digit_pins():
    pins = DigitPin()
    assert len(pins.generate(set())) == 6 and pins.size == 10**6
    assert pins.normalise(" 04-29 17 ") == "042917"
    assert checked(pins) is pins
    with pytest.raises(ValueError):
        checked(TinyPin())


def test_members_found_by_their_pin_however_typed(tmp_path):
    teams = TeamStore(LocalStorage(tmp_path), "teams.json", LetterPin(), b"secret")
    team = teams.create_team("Team 1")
    anna, pin = teams.add_member(team.id, "Anna", "editor")
    assert teams.by_pin(pin.lower().replace("-", " ")) == (team, anna)
    assert teams.by_pin("z-000000") is None and teams.by_pin("") is None
    # Kept as HMACs: the PIN itself is nowhere.
    stored = (tmp_path / "teams.json").read_text()
    assert LetterPin().normalise(pin) not in stored and anna.pin in stored
    # Read back.
    again = TeamStore(LocalStorage(tmp_path), "teams.json", LetterPin(), b"secret")
    assert again.by_pin(pin)[1].id == anna.id
    # Another secret: no PIN is one.
    assert TeamStore(LocalStorage(tmp_path), "teams.json", LetterPin(), b"other").by_pin(pin) is None


def test_distinct_parts_differ_across_the_site(tmp_path):
    teams = TeamStore(LocalStorage(tmp_path), "teams.json", LetterPin("abc"), b"secret")
    one, two = teams.create_team("One"), teams.create_team("One")
    assert (one.id, two.id) == ("one", "one-2")
    letters = [teams.add_member(t.id, n, "editor")[0].distinct for t, n in ((one, "A"), (two, "B"), (one, "C"))]
    assert sorted(letters) == ["a", "b", "c"]
    with pytest.raises(TeamError):
        teams.add_member(one.id, "D", "editor")  # no letter left
    member = teams.team(one.id).members[0]
    regenerated, pin = teams.regenerate_pin(one.id, member.id)
    assert regenerated.distinct == "a" and regenerated.pin_version == 2  # its own letter back


def test_editors_need_a_name(tmp_path):
    teams = TeamStore(LocalStorage(tmp_path), "teams.json", DigitPin(), b"secret")
    team = teams.create_team("T")
    with pytest.raises(TeamError):
        teams.add_member(team.id, " ", "editor")
    assert teams.add_member(team.id, "", "viewer")[0].name == "Viewers"
    with pytest.raises(TeamError):
        teams.create_team("!!")


# Guessing.


def test_throttle_per_ip_and_across_the_site():
    now = [0.0]
    throttle = access.Throttle(free=3, window=60, longest=8, memory=600, ceiling=10, clock=lambda: now[0])
    for _ in range(2):
        throttle.failed("a")
    assert throttle.wait("a") == 0
    throttle.failed("a")
    waits = []
    for _ in range(5):
        waits.append(throttle.wait("a"))
        now[0] += waits[-1]
        throttle.failed("a")
    assert waits == [1, 2, 4, 8, 8]
    assert throttle.wait("b") == 0  # another IP
    now[0] += 61
    assert throttle.wait("a") == 0
    throttle.failed("a")
    assert throttle.wait("a") == 8  # still remembered: no fresh start
    now[0] += 700
    throttle.failed("a")
    assert throttle.wait("a") == 0  # a fresh start
    for _ in range(9):  # 10 with a's last
        assert throttle.wait("c") == 0
        throttle.failed(None)
    assert throttle.wait("c") == 60 and throttle.status()["failures_last_window"] == 10
    assert throttle.status()["site_wait_s"] == 60
    throttle.reset()
    assert throttle.wait("c") == 0 and throttle.status()["failures_last_window"] == 0


def test_throttle_reset_for_one_ip():
    now = [0.0]
    throttle = access.Throttle(free=1, clock=lambda: now[0])
    for ip in ("a", "b"):
        throttle.failed(ip)
        throttle.failed(ip)
    assert throttle.status()["waiting_ips"] == {"a": 2, "b": 2}
    throttle.reset("a")
    assert throttle.wait("a") == 0 and throttle.wait("b") == 2


def test_tokens_are_signed(monkeypatch):
    monkeypatch.setenv("CIVIC_ENGAGEMENT_PIN_SECRET", SECRET)
    token = access.make_token("m-1", 3)
    assert access.read_token(token) == ("m-1", 3)
    payload, _, signature = token.rpartition(".")
    assert access.read_token(payload.replace("m-1", "m-2") + "." + signature) is None
    assert access.read_token("nonsense") is None and access.read_token("a.b.c.d.é") is None
    monkeypatch.setenv("CIVIC_ENGAGEMENT_PIN_SECRET", "another-secret-of-sixteen")
    assert access.read_token(token) is None


# Writes that fail.


class Flaky(LocalStorage):
    down = True

    def write(self, name: str, data: bytes) -> None:
        if self.down:
            raise OSError("unreachable")
        super().write(name, data)


def test_failed_writes_are_kept_and_retried(tmp_path):
    flaky = Flaky(tmp_path)
    retrying = Retrying(flaky, interval=0.01)
    retrying.write("a/x.json", b"1")
    retrying.write("a/x.json", b"2")
    assert retrying.behind == ["a/x.json"] and "unreachable" in retrying.last_error
    assert retrying.read("a/x.json") == b"2" and retrying.names("a") == ["x.json"]
    flaky.down = False
    for _ in range(500):
        if not retrying.behind:
            break
        import time

        time.sleep(0.01)
    assert retrying.behind == [] and (tmp_path / "a" / "x.json").read_bytes() == b"2"


# The app, with teams.


PASSWORD = "manager-password"


@pytest.fixture
def pin_app(tmp_path, monkeypatch):
    """The app with CIVIC_ENGAGEMENT_AUTH=pin, its state in tmp_path."""
    monkeypatch.setenv("CIVIC_ENGAGEMENT_AUTH", "pin")
    monkeypatch.setenv("CIVIC_ENGAGEMENT_STATE", str(tmp_path))
    monkeypatch.setenv("CIVIC_ENGAGEMENT_PIN_SECRET", SECRET)
    monkeypatch.setenv("CIVIC_ENGAGEMENT_MANAGER_USER", "manager")
    monkeypatch.setenv("CIVIC_ENGAGEMENT_MANAGER_PASSWORD", PASSWORD)
    monkeypatch.setenv("CIVIC_ENGAGEMENT_TRUSTED_PROXY", "1")
    monkeypatch.delenv("CIVIC_ENGAGEMENT_FRONTEND", raising=False)
    for cached in (config.auth_mechanism, storage.state_storage, access.team_store):
        cached.cache_clear()
    monkeypatch.setattr(state.store, "_sessions", {})
    access.pin_throttle.reset()
    access.manager_throttle.reset()
    yield TestClient(create_app(active_pack()))
    for cached in (config.auth_mechanism, storage.state_storage, access.team_store):
        cached.cache_clear()
    access.pin_throttle.reset()
    access.manager_throttle.reset()


ADMIN = {"Authorization": "Basic " + base64.b64encode(f"manager:{PASSWORD}".encode()).decode()}


def _login(client, pin: str) -> dict:
    response = client.post("/api/auth/pin", json={"pin": pin}, headers={"X-Forwarded-For": "10.0.0.1"})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['token']}"}


def _workshop(client) -> dict:
    """Two teams: an editor each, and team 1's viewers."""
    pins = {}
    for name in ("Team 1", "Team 2"):
        team = client.post("/api/admin/teams", json={"name": name}, headers=ADMIN).json()
        editor = client.post(f"/api/admin/teams/{team['id']}/members", json={"name": f"Editor {name[-1]}", "role": "editor"}, headers=ADMIN).json()
        pins[f"editor{name[-1]}"] = editor["pin"]
    viewers = client.post("/api/admin/teams/team-1/members", json={"role": "viewer"}, headers=ADMIN).json()
    pins["viewer1"] = viewers["pin"]
    return pins


def test_open_needs_nothing(monkeypatch):
    monkeypatch.delenv("CIVIC_ENGAGEMENT_AUTH", raising=False)
    config.auth_mechanism.cache_clear()
    client = TestClient(create_app(active_pack()))
    assert client.get("/api/auth/info").json() == {"mechanism": "open", "example": None}
    assert client.get("/api/auth/me").json()["role"] == "editor"
    assert client.get("/api/scene").status_code == 200
    assert client.get("/api/admin/teams").status_code == 404  # no manager without teams


def test_every_route_needs_a_token(pin_app):
    assert pin_app.get("/api/health").status_code == 200
    assert pin_app.get("/api/auth/info").json() == {"mechanism": "pin", "example": "123456"}
    for path in ("/api/scene", "/api/cards", "/api/baseline", "/api/site-assets", "/api/scenarios", "/api/auth/me"):
        assert pin_app.get(path).status_code == 401, path
    assert pin_app.get("/api/scene", headers={"Authorization": "Bearer forged.1.2.x"}).status_code == 401
    assert pin_app.get("/api/admin/teams").status_code == 401
    assert pin_app.get("/api/admin/teams", headers={"Authorization": "Basic " + base64.b64encode(b"manager:no").decode()}).status_code == 401


def test_teams_apart_and_viewers_looking(pin_app, tmp_path):
    pins = _workshop(pin_app)
    editor1, editor2, viewer1 = (_login(pin_app, pins[k]) for k in ("editor1", "editor2", "viewer1"))
    me = pin_app.get("/api/auth/me", headers=viewer1).json()
    assert (me["team"]["name"], me["role"]) == ("Team 1", "viewer")

    revision2 = pin_app.get("/api/session/revision", headers=editor2).json()
    scene = pin_app.post("/api/interventions", json=BENCH, headers=editor1).json()
    (card,) = scene["interventions"]
    assert card["created_by"] == "Editor 1"
    # Team 1's viewers see it; team 2 doesn't, and isn't told to look.
    assert [i["id"] for i in pin_app.get("/api/scene", headers=viewer1).json()["interventions"]] == [card["id"]]
    assert pin_app.get("/api/scene", headers=editor2).json()["interventions"] == []
    assert pin_app.get("/api/session/revision", headers=editor2).json() == revision2
    # Not team 2's card to change.
    assert pin_app.delete(f"/api/interventions/{card['id']}", headers=editor2).status_code == 404

    # Viewers can't change anything.
    for method, path, body in (
        ("post", "/api/interventions", BENCH),
        ("patch", f"/api/interventions/{card['id']}", {"params": {}}),
        ("delete", f"/api/interventions/{card['id']}", None),
        ("post", "/api/scenarios", {"name": "x"}),
        ("post", "/api/session/clear", None),
    ):
        assert pin_app.request(method.upper(), path, json=body, headers=viewer1).status_code == 403, path

    # Each team's scenarios.
    assert pin_app.post("/api/scenarios", json={"name": "Idea"}, headers=editor1).status_code == 200
    assert [s["id"] for s in pin_app.get("/api/scenarios", headers=viewer1).json()] == ["idea"]
    assert pin_app.get("/api/scenarios", headers=editor2).json() == []
    assert pin_app.post("/api/scenarios/idea/load", headers=editor2).status_code == 404

    # In the state: a document per team.
    session = json.loads((tmp_path / "tests/toy_pack/data/sessions/team-1.json").read_text())
    assert [i["id"] for i in session["team-1"]] == [card["id"]]
    assert (tmp_path / "tests/toy_pack/data/scenarios/team-1/idea.json").is_file()


def test_the_manager_runs_the_teams(pin_app):
    pins = _workshop(pin_app)
    editor1 = _login(pin_app, pins["editor1"])
    pin_app.post("/api/interventions", json=BENCH, headers=editor1)
    pin_app.post("/api/scenarios", json={"name": "Idea"}, headers=editor1)

    teams = pin_app.get("/api/admin/teams", headers=ADMIN).json()
    assert [(t["id"], t["interventions"], len(t["members"])) for t in teams] == [("team-1", 1, 2), ("team-2", 0, 1)]
    assert all(m["pin"] is None for t in teams for m in t["members"])  # shown once only

    # A team started from another's scenario.
    copy = pin_app.post("/api/admin/teams", json={"name": "Team 3", "from_scenario": "idea", "from_team": "team-1"}, headers=ADMIN)
    assert copy.json()["interventions"] == 1
    # Its scene emptied, then the scenario again.
    assert pin_app.post("/api/admin/teams/team-3/scene", json={}, headers=ADMIN).json()["interventions"] == 0
    assert pin_app.post("/api/admin/teams/team-3/scene", json={"scenario": "idea", "team": "team-1"}, headers=ADMIN).json()["interventions"] == 1
    assert pin_app.post("/api/admin/teams/team-3/scene", json={"scenario": "nothing"}, headers=ADMIN).status_code == 404

    export = pin_app.get("/api/admin/teams/team-1/export", headers=ADMIN).json()
    assert len(export["interventions"]) == 1 and list(export["scenarios"]) == ["idea.json"]
    assert "pin" not in json.dumps(export["team"]).replace('"pin": null', "").replace("pin_version", "")

    # A new PIN: the old one, and its token, are out.
    member = teams[0]["members"][0]
    new = pin_app.post(f"/api/admin/teams/team-1/members/{member['id']}/pin", headers=ADMIN).json()
    assert new["pin_version"] == 2 and new["pin"] != pins["editor1"]
    assert pin_app.get("/api/scene", headers=editor1).status_code == 401
    assert pin_app.post("/api/auth/pin", json={"pin": pins["editor1"]}).status_code == 401
    _login(pin_app, new["pin"])

    # Deleted: its members out, its documents gone.
    viewer1 = _login(pin_app, pins["viewer1"])
    assert pin_app.delete("/api/admin/teams/team-1", headers=ADMIN).status_code == 204
    assert pin_app.get("/api/scene", headers=viewer1).status_code == 401
    team = pin_app.post("/api/admin/teams", json={"name": "Team 1"}, headers=ADMIN).json()
    assert team["id"] == "team-1" and team["interventions"] == 0

    status = pin_app.get("/api/admin/status", headers=ADMIN).json()
    assert status["teams"] == 3 and status["storage"]["behind"] == []


def test_guessing_pins_waits(pin_app):
    _workshop(pin_app)
    guess = lambda ip: pin_app.post("/api/auth/pin", json={"pin": "000000"}, headers={"X-Forwarded-For": ip})  # noqa: E731
    for _ in range(10):
        assert guess("10.0.0.9").status_code in (401, 200)
    response = guess("10.0.0.9")
    assert response.status_code == 429 and int(response.headers["retry-after"]) >= 1
    # Another IP isn't held up.
    assert guess("10.0.0.8").status_code != 429
    # Nor is the manager, from the same IP; who can let it try again.
    manager = {**ADMIN, "X-Forwarded-For": "10.0.0.9"}
    status = pin_app.get("/api/admin/status", headers=manager).json()["throttle"]
    assert "10.0.0.9" in status["pins"]["waiting_ips"] and status["manager"]["waiting_ips"] == {}
    assert pin_app.post("/api/admin/throttle/reset", json={"ip": "10.0.0.9"}, headers=manager).json()["waiting_ips"] == {}
    assert guess("10.0.0.9").status_code == 401


def test_wrong_manager_passwords_dont_hold_pins_up(pin_app):
    pins = _workshop(pin_app)
    wrong = {"Authorization": "Basic " + base64.b64encode(b"manager:wrong").decode(), "X-Forwarded-For": "10.0.0.7"}
    for _ in range(5):
        assert pin_app.get("/api/admin/status", headers=wrong).status_code == 401
    assert pin_app.get("/api/admin/status", headers=wrong).status_code == 429
    response = pin_app.post("/api/auth/pin", json={"pin": pins["editor1"]}, headers={"X-Forwarded-For": "10.0.0.7"})
    assert response.status_code == 200


def test_a_short_manager_password_is_refused(pin_app, monkeypatch):
    monkeypatch.setenv("CIVIC_ENGAGEMENT_MANAGER_PASSWORD", "short")
    with pytest.raises(RuntimeError, match="at least 12"):
        access.check_configuration()


def test_the_cli(pin_app, monkeypatch, capsys):
    """civic-engagement-admin against the app, served on a free port."""
    import socket
    import threading
    import time

    import uvicorn

    from civic_engagement import admin

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(pin_app.app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    while not server.started:
        time.sleep(0.01)
    monkeypatch.setenv("CIVIC_ENGAGEMENT_ADMIN_URL", f"http://127.0.0.1:{port}")
    try:
        admin.main(["team", "create", "Team 1"])
        admin.main(["member", "add", "team-1", "Anna", "--editor"])
        pin = capsys.readouterr().out.split("PIN ")[-1].strip()
        assert len(pin) == 6
        admin.main(["member", "add", "team-1", "--viewers"])
        admin.main(["member", "pin", "team-1", "Anna"])
        assert capsys.readouterr().out.split("PIN ")[-1].strip() != pin
        admin.main(["team", "list"])
        listed = capsys.readouterr().out
        assert "team-1  Team 1  (0 cards)" in listed and "viewer  Viewers" in listed
        admin.main(["export", "team-1"])
        assert json.loads(capsys.readouterr().out)["team"]["id"] == "team-1"
        with pytest.raises(SystemExit, match="404"):
            admin.main(["scene", "set", "team-1", "nothing"])
        admin.main(["member", "remove", "team-1", "Viewers"])
        admin.main(["team", "delete", "team-1", "--yes"])
        admin.main(["status"])
        assert json.loads(capsys.readouterr().out.split("\n", 2)[-1])["teams"] == 0
        admin.main(["throttle", "reset"])
        assert "everyone" in capsys.readouterr().out
        with pytest.raises(SystemExit, match="401"):
            admin.Admin(f"http://127.0.0.1:{port}", "manager", "wrong").call("GET", "/status")
    finally:
        server.should_exit = True
        thread.join()
