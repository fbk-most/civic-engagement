# Multiple teams

**Status: design agreed; phase 1 (packaging) built, phases 2 and 3 to do** (October 2026).

This document is the core's part: what every domain pack and every
installation gets. Running the app as a container on the DigitalHub
platform is in [deploy-digitalhub.md](deploy-digitalhub.md); each pack
documents its own deployment (for the urban pack:
`bologna-civic-dt/docs/deploy-digitalhub.md`).

## Goal

Today the app serves one site per process, and one shared session: every
open window sees, and can change, the same cards. No one logs in.

This step makes it serve **several teams working independently on the same
site**:

- Each team has its own scene (its cards) and its own scenarios.
- Within a team, some members can change the scene (**editors**); the others
  can only look at it (**viewers**), each with their own year, date, hour
  and point of view.
- Participants have **no accounts**: they get a short PIN.
- A **manager** sets the teams up and hands out the PINs.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Names | **team**, **member**, **editor** / **viewer**, **manager**; "team" in the Italian interface too | The core is domain-agnostic: a workshop table is one use of a team. |
| Isolation | **One process per site, many teams inside it** | The core keeps one site per process (`SITE` is read when modules are imported); teams on a site share its baseline, the "as is" evaluation and the pack's cached computations. One process per team would multiply deployments; one for all sites would undo the core's design. |
| Authentication | **Chosen by the deployment**: `open` (no login, today's behaviour; the default) or `pin`; others (an identity provider) can be added | Which mechanism suits depends on where and with whom the app runs, not on the core. Teams and roles are the core's either way. |
| Participants | **PINs**, no accounts, no links or QR codes (with `pin`) | Citizens in a workshop have no accounts; links and QR codes don't suit how the app is used. |
| PIN format | **The pack's**: the core's default is 6 digits; a pack can provide its own (the urban pack: an Italian word and 3 digits, `carciofo515`) | What is easy to say and remember depends on the language and the users; the mechanism around it doesn't. |
| PINs | One PIN **per editor** (so a card's author is a person), one **viewer PIN per team**, unique within the site | A PIN alone says team, role and member: no team list to show publicly. |
| Manager | Basic credentials from the environment; **API and CLI only**, no manager UI for now | Few managers, few operations. A sign-in with an identity provider can come later without changing the model. |
| Viewers | **Independent**: their own year, date, hour, POV and layers | Already the case: these are per window (URL parameters). |
| Concurrent editors | **Last write wins**; each card records its author | Placement is immutable, a change touches only parameters: conflicts are rare and visible. |
| Scenarios | **Private to the team**; the site's presets can be loaded by every team | Requirements for publishing scenarios across teams aren't clear yet. |
| End of a workshop | Nothing automatic: teams stay until the manager acts | To be added as manager actions (read-only, archive, delete). |
| State | **Behind a storage interface**: a local directory, or **S3** (any S3-compatible store); written through on every change, memory the working copy | A container's disk may not outlive it (it doesn't on DigitalHub); the JSON format stays today's. |
| Replicas | **Exactly one process** per site's state | State is in memory; one writer. |

## Access

### Mechanisms

`CIVIC_ENGAGEMENT_AUTH` chooses how a request is given its team, member
and role. The core's routes, store and frontend only see that answer, not
how it was reached.

- **`open`** (the default): no login. One team, `default`, and every window
  an editor: today's app, for development, demos on a laptop and tests.
  Sessions and scenarios stay in the local directory, `data/<site>/`
  (today's `session.json` and `scenarios/` read as the `default` team's);
  the manager's API is off.
- **`pin`**: the PINs below.
- Later, others behind the same interface, e.g. an identity provider for
  managers or staff.

### PINs

The mechanism is the core's; **the format is the pack's**.

A format (`DomainPack.pin_format`, a `PinFormat`) says three things:

- `generate(taken)`: a new PIN, given the distinguishing parts already in
  use on the site;
- `normalise(text)`: what the person typed, as the PIN to check — the
  forgiving part (case, spaces, hyphens...);
- `distinct(pin)`: the part that must differ between the PINs of a site
  (none, for digits), kept in clear to check it; and an `example`
  and `size` (how many PINs it can make), for the login screen and the
  documentation.

The core's default, `DigitPin`, is 6 digits: 10⁶ PINs, nothing distinct.
The urban pack's is a word and three digits (`carciofo515`), from an
Italian word list in the pack: see its `docs/deploy-digitalhub.md`.

Whatever the format:

- PINs are generated by the backend, never chosen by hand, and shown once,
  when created or regenerated;
- a format must make **at least 10⁶ PINs** (the strength assumed in
  [Guessing PINs](#guessing-pins)): the core refuses a smaller one.

A site's teams and members, in `teams.json`:

```json
{
  "teams": [
    {
      "id": "team-1", "name": "Team 1", "created_at": "...",
      "members": [
        {"id": "m-…", "name": "Anna", "role": "editor", "pin": "<hmac>", "pin_version": 1},
        {"id": "m-…", "name": "Viewers", "role": "viewer", "pin": "<hmac>", "pin_version": 1}
      ]
    }
  ]
}
```

A PIN is stored as `HMAC(secret, normalised pin)`, the secret from the
environment (`CIVIC_ENGAGEMENT_PIN_SECRET`). The HMAC is deterministic: a
PIN is found by its HMAC. The distinct part (the urban pack's word) is
stored apart, in clear, next to it (`"distinct": "carciofo"`); on its own
it leaves the rest to guess (1000 PINs, for the urban format).

### Logging in

1. The app opens on a screen with one field, "Codice".
2. `POST /api/auth/pin {"pin": "…"}` → `{"token": "…", "team": {...}, "member": {...}, "role": "editor"}`,
   or 401.
3. The token is **signed, not stored**: `member_id`, `pin_version` and the
   time it was issued, with an HMAC over them. It survives a restart and a
   redeploy (no one types the PIN again), and needs no storage.
4. The frontend keeps the token in `localStorage` (a reload, a new tab or
   a shared view URL doesn't ask again) and sends it on every call:
   `Authorization: Bearer <token>`. A "Change team" control forgets it.
5. Every request checks the token: unknown member, or a `pin_version` other
   than the member's current one → 401, and the frontend goes back to the
   PIN screen. Regenerating or revoking a PIN bumps its version: whoever
   used it is out. That's also the only way to cut one device off.

### Guessing PINs

A format makes at least 10⁶ PINs; the code is public, so that size (not
the format's details) is all that counts. 30 valid PINs: about one guess in
33,000 hits.

- **Throttling per client IP**: after 5 failures in a minute, the next
  attempts from that IP wait, doubling up to a few minutes. One IP would
  need days to find a PIN.
- **A site-wide ceiling** on failures per minute, logged, against guessing
  spread over many IPs: beyond it, every attempt waits.
- **No lockout per team or PIN**: a PIN doesn't name its team, and a lockout
  would let anyone block a team.
- What a PIN found by guessing allows: a viewer PIN, looking; an editor PIN,
  changing a team's cards — recoverable: the author is on the cards, the
  manager regenerates the PIN, and the scene as it was is set aside on
  every load or clear.

The client's IP, behind a proxy or gateway, is in `X-Forwarded-For`, which
can be trusted only when the proxy sets it: `CIVIC_ENGAGEMENT_TRUSTED_PROXY`
says whether to read it. Without it, only the site-wide ceiling applies.

### What each role can do

| | Viewer | Editor | Manager |
|---|---|---|---|
| Scene, indicators, the pack's views, year/date/POV | ✓ | ✓ | |
| Add, change, remove cards | | ✓ | |
| Save, load, delete the team's scenarios; clear the scene | | ✓ | |
| Load a site preset | | ✓ | |
| Teams, members, PINs, starting scene, export | | | ✓ |

With `pin`, every route but `/api/auth/*` and `/api/health` needs a
token, the team-independent ones too (baseline, cards, site assets,
descriptors): everything sits behind a PIN, with no exceptions to
remember. (With `open`, no route does.) Mutations by
a viewer → 403. The manager's routes (`/api/admin/*`) take Basic
credentials, not a token: a manager doesn't act inside a team's scene.

The app must not count on the network to keep others out (on DigitalHub,
every project shares a Kubernetes namespace): the checks above are the
access control.

## Backend

### Routes

The team comes from the token, never from the URL or the body: a member
can't name another team.

| Routes | Change |
|---|---|
| `GET /scene`, `GET /session/revision`, `GET /indicators/deferred`, `GET /indicators/series`, `GET /interventions` | the token's team |
| `POST/PATCH/DELETE /interventions…`, `POST /session/clear` | the token's team; editors only; the author recorded |
| `GET/POST/DELETE /scenarios…`, `POST /scenarios/{id}/load` | the team's library, plus the site's presets (listed apart, read-only); editors only for changes |
| `GET /auth/info` | new: the mechanism, and for `pin` the format's `example` (the login screen's hint) |
| `POST /auth/pin`, `GET /auth/me` | new |
| `/admin/...` | new, see [Manager](#manager) |
| `GET /health` | new: the process is up and its state loaded |

**Packs**: a pack's routes reading the session (the urban pack's
`/thermal-field`) take the team through a dependency the core provides,
and the role check with it; `DomainPack`'s methods are unchanged — they
already receive the interventions, not the session.

`Intervention` gains `created_by` and `updated_by` (the member's name, as
it was then), shown with the card.

### Store

- `SessionStore` keeps one session **per team** (the `session_id` already
  in its methods becomes the team id), and one revision per team: a team's
  change doesn't make the other teams' windows refetch.
- **A lock** around every change and its write: FastAPI runs the routes in
  threads.
- **Storage behind an interface**: read, write and list named JSON
  documents. Two implementations:
  - a **local directory**: development, tests, a single machine (today's
    behaviour);
  - **S3**: any S3-compatible store, credentials from the standard
    `AWS_*` variables.

  Chosen by `CIVIC_ENGAGEMENT_STATE`: `s3://<bucket>/<prefix>` or a
  directory (default: the current one, so `data/<site>/` as today). The
  interface and the local directory are in phase 1
  (`civic_engagement/store/storage.py`), with today's documents: the
  session and the saved scenarios.
- Documents, under `<root>/data/<site>/`:

  ```
  teams.json
  sessions/<team>.json
  sessions/<team>.<timestamp>.json      the scene as it was, set aside on a load or clear
  scenarios/<team>/<scenario>.json
  ```

- **Written through**: each change is written before the route answers (a
  few KB). A failed write keeps the change in memory, marks the store as
  behind, retries in the background, and shows in `GET /admin/status` and
  the logs: a short outage of the store doesn't stop a workshop, and isn't
  silent.
- **Read at startup**: every document of the site; `/health` answers only
  then.
- The read-only data — baseline, terrain, the site's preset scenarios —
  stays in `data/<site>/`, shipped with the app.

### Caches and computation

- The evaluation cache (`scene.py`) becomes an LRU (size from
  `CIVIC_ENGAGEMENT_EVALUATIONS`, default 8: a team each plus "as is").
  Today's single entry would re-evaluate on every request as soon as two
  teams differ.
- Packs' caches keyed by interventions (the urban felt-temperature fields)
  are already shared by teams with the same cards; their sizes are the
  pack's.
- **Parallelism from the CPU quota, not the CPU count**: in a container,
  `os.cpu_count()` is the machine's (16 where the quota is 4, on
  DigitalHub). `civic_engagement.config.cpus()` reads
  `CIVIC_ENGAGEMENT_CPUS`, or else the cgroup's `cpu.max`; the core's
  container launcher (`python -m civic_engagement.serve <module>:app`)
  sets `OMP_NUM_THREADS`, `OPENBLAS_NUM_THREADS` and `MKL_NUM_THREADS` from
  it before the app, and numpy, load; packs size their own pools from it.

### Serving the app

- FastAPI serves the pack's built frontend at `/` when
  `CIVIC_ENGAGEMENT_FRONTEND` names it (its `frontend/dist`), with the API
  under `/api`: one origin, no CORS, no `vite preview` in production.
  Vite's content-named bundles (`assets/`) cached for good, the rest
  checked on every load.
- The CORS middleware only in development, without a frontend.
- The frontend calls absolute `/api/...` paths: the app must be at the
  root of its hostname.

## Manager

The admin API, with Basic credentials (`CIVIC_ENGAGEMENT_MANAGER_USER`,
`CIVIC_ENGAGEMENT_MANAGER_PASSWORD`):

| Route | Does |
|---|---|
| `GET /admin/teams`, `POST /admin/teams`, `PATCH /admin/teams/{id}`, `DELETE /admin/teams/{id}` | teams: list, create (optionally from a site preset or another team's scenario), rename, delete |
| `POST /admin/teams/{id}/members`, `DELETE …/members/{m}`, `POST …/members/{m}/pin` | members: add (an editor with a name, or the viewers), remove, regenerate the PIN; the new PIN is in the answer, once |
| `POST /admin/teams/{id}/scene` | the team's scene becomes a scenario (or empty); the previous one set aside |
| `GET /admin/teams/{id}/export` | the team: its scene, the scenes set aside, its scenarios; the file to hand back to the organisers |
| `GET /admin/status` | teams, members, storage (behind or not, last write), the throttling's state |

And a CLI over it, in the core (standard library only), reading the URL
and the credentials from the environment:

```
civic-engagement-admin team create "Team 1" [--from <scenario>]
civic-engagement-admin team list | rename <team> <name> | delete <team>
civic-engagement-admin member add <team> "Anna" --editor | member add <team> --viewers
civic-engagement-admin member pin <team> <member>          # regenerates; prints the new PIN
civic-engagement-admin member remove <team> <member>
civic-engagement-admin scene set <team> <scenario>|--empty
civic-engagement-admin export <team> > team-1.json
civic-engagement-admin status
```

## Frontend

- With `pin`, the PIN screen: "Codice" in Italian, the format's example as
  its hint (`GET /auth/info`). With `open`, no screen: the app as today.
- The token in `localStorage`, sent by `api/client.ts` on every call (all
  calls already go through it); a 401 brings back the PIN screen. Packs'
  calls go through the same client.
- The team's and the member's name in the header, with "Change team".
- **Read-only for viewers**: no card palette, no editing of a card, no
  saving, loading or clearing. The 403 from the backend is the guarantee;
  the interface doesn't offer what would be refused.
- The author on a card's details.
- The site's presets apart from the team's scenarios in the scenario menu.

Revision polling (every 3 s) stays as it is, now per team.

## Running in a container

What a pack's image of the app can count on, and must respect, wherever it
runs:

- **Any non-root user**, by number (`USER 1000:1000`); nothing written
  outside `/tmp` and the state store.
- **Port 8080**; `GET /api/health` for readiness.
- **Configured by environment**: `CIVIC_ENGAGEMENT_SITE`,
  `CIVIC_ENGAGEMENT_FRONTEND` (set by the image), `CIVIC_ENGAGEMENT_AUTH`,
  `CIVIC_ENGAGEMENT_STATE`, `CIVIC_ENGAGEMENT_CPUS`, the secrets
  (`CIVIC_ENGAGEMENT_PIN_SECRET`, the manager's credentials, the store's
  `AWS_*`), `CIVIC_ENGAGEMENT_TRUSTED_PROXY`.
- **State outside the container** (S3) when the container's disk doesn't
  outlive it; **one process** per site's state, and a new one started only
  once the old one has stopped.
- **The root of a hostname**, one per site.
- `CIVIC_ENGAGEMENT_PIN_SECRET` must stay the same across deployments:
  changing it invalidates every PIN and token.

## Phases

1. **Packaging** (built) — no behaviour change. The storage interface
   (local directory only), FastAPI serving the frontend, `/api/health`,
   parallelism from the quota, the container launcher. Each pack: its
   image and deployment.
2. **Teams and roles.** Store per team with its lock, the S3 storage; the
   `open` and `pin` mechanisms, tokens, the `PinFormat` interface and
   `DigitPin`, throttling; roles on routes, the team dependency for packs,
   the admin API and CLI; the frontend's PIN screen and read-only mode,
   authors on cards, caches. Each pack: its PIN format, if not digits.
3. **Hardening.** A load test, tuning, the upgrade and backup procedures,
   a trial workshop.

Every pack gets phases 1 and 2 by moving to the new core: the token on
every call is the core's frontend's, so it comes with it; a pack's own
routes reading the session move to the core's team dependency.

## Not in this step

- Sign-in for managers with an identity provider (on DigitalHub, the
  gateway's JWT and the platform's OIDC issuer).
- "Follow the facilitator": viewers' year, date and POV following an
  editor's.
- Push (SSE) instead of polling.
- Scenarios published across teams.
- Undo and history beyond the scenes set aside.
- Several processes per site (would need the state in a database).
