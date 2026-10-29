"""civic-engagement-admin: the manager's API (api/routes_admin.py) from a
terminal. The standard library only: it runs wherever Python does, without
the app installed.

The app's address and the manager's credentials from the environment:
CIVIC_ENGAGEMENT_ADMIN_URL (http://localhost:8000 by default),
CIVIC_ENGAGEMENT_MANAGER_USER, CIVIC_ENGAGEMENT_MANAGER_PASSWORD.

    civic-engagement-admin team create "Team 1" [--from <scenario> [--of <team>]]
    civic-engagement-admin team list | rename <team> <name> | delete <team> --yes
    civic-engagement-admin member add <team> "Anna" --editor | member add <team> --viewers
    civic-engagement-admin member pin <team> <member>      # a new PIN, printed
    civic-engagement-admin member remove <team> <member>
    civic-engagement-admin scene set <team> <scenario> [--of <team>] | scene set <team> --empty
    civic-engagement-admin export <team> > team-1.json
    civic-engagement-admin status
    civic-engagement-admin throttle reset [<ip>]               # wrong PINs forgotten: an IP's, or everyone's

A member is named by its id or its name.
"""

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request


class Admin:
    def __init__(self, url: str, user: str, password: str) -> None:
        self.url = url.rstrip("/")
        self._auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()

    def call(self, method: str, path: str, body: dict | None = None):
        request = urllib.request.Request(
            f"{self.url}/api/admin{path}",
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": self._auth, "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request) as response:
                data = response.read()
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace")
            try:
                detail = json.loads(detail).get("detail", detail)
            except ValueError:
                pass
            raise SystemExit(f"{method} {path}: {error.code} {detail}") from None
        except urllib.error.URLError as error:
            raise SystemExit(f"{self.url}: {error.reason}") from None
        return json.loads(data) if data else None

    def member_id(self, team: str, member: str) -> str:
        members = next((t["members"] for t in self.call("GET", "/teams") if t["id"] == team), None)
        if members is None:
            raise SystemExit(f"No team {team!r}")
        found = [m["id"] for m in members if member in (m["id"], m["name"])]
        if len(found) != 1:
            names = ", ".join(f"{m['name']} ({m['id']})" for m in members)
            raise SystemExit(f"{member!r}: {'no such member' if not found else 'more than one'} in {team}: {names}")
        return found[0]


def _print_team(team: dict) -> None:
    print(f"{team['id']}  {team['name']}  ({team['interventions']} cards)")
    for member in team["members"]:
        print(f"    {member['role']:6}  {member['name']:20}  {member['id']}")


def _print_pin(member: dict) -> None:
    print(f"{member['role']} {member['name']} ({member['id']}): PIN {member['pin']}")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="civic-engagement-admin", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)

    team = commands.add_parser("team").add_subparsers(dest="action", required=True)
    create = team.add_parser("create")
    create.add_argument("name")
    create.add_argument("--from", dest="scenario", help="its starting scene: a site preset, or a scenario of --of")
    create.add_argument("--of", dest="of_team", help="the team whose scenario --from is")
    team.add_parser("list")
    rename = team.add_parser("rename")
    rename.add_argument("team")
    rename.add_argument("name")
    delete = team.add_parser("delete", help="the team, its members, scene and scenarios")
    delete.add_argument("team")
    delete.add_argument("--yes", action="store_true", required=True, help="yes, for good")

    member = commands.add_parser("member").add_subparsers(dest="action", required=True)
    add = member.add_parser("add")
    add.add_argument("team")
    add.add_argument("name", nargs="?", default="")
    role = add.add_mutually_exclusive_group(required=True)
    role.add_argument("--editor", action="store_const", dest="role", const="editor")
    role.add_argument("--viewers", action="store_const", dest="role", const="viewer")
    for action in ("pin", "remove"):
        command = member.add_parser(action)
        command.add_argument("team")
        command.add_argument("member", help="its id or name")

    scene = commands.add_parser("scene").add_subparsers(dest="action", required=True)
    set_scene = scene.add_parser("set")
    set_scene.add_argument("team")
    what = set_scene.add_mutually_exclusive_group(required=True)
    what.add_argument("scenario", nargs="?")
    what.add_argument("--empty", action="store_true")
    set_scene.add_argument("--of", dest="of_team", help="the team whose scenario it is (default: its own, or a preset)")

    export = commands.add_parser("export")
    export.add_argument("team")
    commands.add_parser("status")
    throttle = commands.add_parser("throttle").add_subparsers(dest="action", required=True)
    reset = throttle.add_parser("reset", help="forget wrong PINs, so that those held up can try again")
    reset.add_argument("ip", nargs="?", help="only this IP's (default: everyone's)")

    args = parser.parse_args(argv)
    admin = Admin(
        os.environ.get("CIVIC_ENGAGEMENT_ADMIN_URL", "http://localhost:8000"),
        os.environ.get("CIVIC_ENGAGEMENT_MANAGER_USER", ""),
        os.environ.get("CIVIC_ENGAGEMENT_MANAGER_PASSWORD", ""),
    )

    match args.command, getattr(args, "action", None):
        case "team", "create":
            _print_team(admin.call("POST", "/teams", {"name": args.name, "from_scenario": args.scenario, "from_team": args.of_team}))
        case "team", "list":
            for found in admin.call("GET", "/teams"):
                _print_team(found)
        case "team", "rename":
            _print_team(admin.call("PATCH", f"/teams/{args.team}", {"name": args.name}))
        case "team", "delete":
            admin.call("DELETE", f"/teams/{args.team}")
            print(f"Deleted {args.team}")
        case "member", "add":
            _print_pin(admin.call("POST", f"/teams/{args.team}/members", {"name": args.name, "role": args.role}))
        case "member", "pin":
            _print_pin(admin.call("POST", f"/teams/{args.team}/members/{admin.member_id(args.team, args.member)}/pin"))
        case "member", "remove":
            admin.call("DELETE", f"/teams/{args.team}/members/{admin.member_id(args.team, args.member)}")
            print(f"Removed {args.member} from {args.team}")
        case "scene", "set":
            body = {} if args.empty else {"scenario": args.scenario, "team": args.of_team}
            _print_team(admin.call("POST", f"/teams/{args.team}/scene", body))
        case "export", _:
            json.dump(admin.call("GET", f"/teams/{args.team}/export"), sys.stdout, indent=1, ensure_ascii=False)
            print()
        case "status", _:
            print(json.dumps(admin.call("GET", "/status"), indent=1))
        case "throttle", "reset":
            admin.call("POST", "/throttle/reset", {"ip": args.ip})
            print(f"Wrong PINs forgotten: {args.ip or 'everyone'}")


if __name__ == "__main__":
    main()
