# Deploying on DigitalHub

**Status: guide from tests; the urban pack's image built, not yet deployed** (October 2026).

How a pack's app runs on [DigitalHub](https://scc-digitalhub.github.io/docs/0.15/)
(version 0.15) as a container, for any domain and any DigitalHub instance.
What the app itself provides — teams, PINs, the state's storage — is in
the core's README ("Teams"); what its image must respect, in
[The image](#the-image) below. Each pack documents its own deployment —
image, sites, parameters, instance — in its repository (for the urban pack:
`bologna-civic-dt/docs/deploy-digitalhub.md`).

What follows was measured on the instance *digitalhub-bologna* (core
0.15.1) on 24 October 2026. Some of it is the platform's behaviour, some
the instance's configuration (marked *instance*): check it on another
instance with the [tests](#checking-an-instance) below.

## The model

- A **project** holds functions and their runs. Every project of an
  instance runs in one Kubernetes namespace, shared by every user.
- A pack's app is a **container function** (`kind="container"`, the
  image), run with the **`serve`** action: a Kubernetes deployment and a
  service, inside the cluster only.
- **One run per site** (the core serves one site per process), with
  `replicas=1`.
- The service is published by a **gateway route** (an HTTPRoute, made in
  the Kubernetes Resource Manager, KRM): a hostname, a path, an
  authentication (None, Basic, ApiKey, JWT).
- Runs are created with the [Python SDK](https://pypi.org/project/digitalhub/)
  (`digitalhub` and `digitalhub-runtime-container`, the version matching
  the instance's core), from a script kept in the pack's repository.

## What the platform imposes

| | Behaviour | What to do |
|---|---|---|
| Root | `runAsNonRoot` enforced, privilege escalation off, every capability dropped (*instance*). An image running as root never starts: the run stays **`PENDING`** with `CreateContainerConfigError`, never `ERROR` | `USER 1000:1000` in the image; `run_as_user=1000, run_as_group=1000, fs_group=1000` in the run |
| Images | Pulled from public registries (Docker Hub, GHCR) without credentials | A public image; otherwise, a pull secret (ask the administrators) |
| Pulls | `imagePullPolicy: IfNotPresent`: a node that has an image's tag doesn't pull it again | Tags that never move (a version, a commit); or the function's `image_pull_policy="Always"` |
| Resources | Without `resources`, no guarantee (`BestEffort`). `{"cpu": "4", "mem": "4Gi"}` gives requests = limits for the CPU, a memory limit about 10% above the request | Always set `resources` |
| CPUs | The container sees the machine's CPUs (`nproc`: 16 under a quota of 4) | `CIVIC_ENGAGEMENT_CPUS` set to the quota |
| Volumes | A `persistent_volume_claim` is **created per run** (`v-<run-id>-<name>`): kept across a stop and resume of the run, but a new run gets a new, empty one. The platform can be configured to refuse pre-existing volumes | No durable state on volumes |
| Credentials | Every pod gets S3 credentials (`AWS_*`, `S3_BUCKET`), Postgres ones (`DB_*`) and a platform token with a refresh token — **temporary**: about 5.5 hours (*instance*) | Not for a service running for weeks: long-lived credentials as a **project secret**, passed with `secrets=[…]` |
| S3 | Reading and writing under `<bucket>/<prefix>/` works from a run | `CIVIC_ENGAGEMENT_STATE=s3://<bucket>/<prefix>` |
| Network | The cluster reaches the internet (*instance*) | — |
| Services | Each run has its service, `s-containerserve-<run-id>`; each function also a **stable alias**, `s-<project>-<function>-latest`, pointing at its latest run | Gateway routes to the alias |
| Namespace | Every project's pods see every service (Kubernetes injects their addresses as variables) | The app's own access checks |
| KRM | Without the role or the schemas, KRM shows only *Settings* ("Please add a schema to enable CR management"): no gateways, S3 users or databases (*instance*) | Ask the administrators |
| SDK | `Run.logs()` of SDK 0.15.11 fails on core 0.15.1 (log entries without the `name` it expects) | The SDK version the administrators advise; logs from the console |

## Deploying

### The image

Built outside the platform (the pack's CI, e.g. GitHub Actions to GHCR).
It starts the app with the core's launcher, `python -m
civic_engagement.serve <module>:app`, and sets `CIVIC_ENGAGEMENT_FRONTEND`
to the built app (the urban pack's `Dockerfile` is an example). What a
pack's image can count on, and must respect, wherever it runs:

- **Any non-root user**, by number (`USER 1000:1000`); nothing written
  outside `/tmp` and the state's storage.
- **Port 8080**; `GET /api/health` for readiness.
- **Configured by environment**: `CIVIC_ENGAGEMENT_SITE`,
  `CIVIC_ENGAGEMENT_FRONTEND` (set by the image), `CIVIC_ENGAGEMENT_AUTH`,
  `CIVIC_ENGAGEMENT_STATE`, `CIVIC_ENGAGEMENT_CPUS`, the secrets
  (`CIVIC_ENGAGEMENT_PIN_SECRET`, the manager's credentials, the store's
  `AWS_*` with S3), `CIVIC_ENGAGEMENT_TRUSTED_PROXY`.
- **State outside the container** when the container's disk doesn't
  outlive it; **one process** per site's state, and a new one started only
  once the old one has stopped.
- **The root of a hostname**, one per site.
- `CIVIC_ENGAGEMENT_PIN_SECRET` must stay the same across deployments:
  changing it invalidates every PIN and token.

### The run

A pack's deployment script does this (the urban pack's:
`scripts/deploy_digitalhub.py`, which also stops the site's running runs
first):

```python
import digitalhub as dh

project = dh.get_or_create_project("<project>")
function = project.new_function(name="<pack>-<site>", kind="container", image="<image>:<version>")
run = function.run(
    action="serve",
    service_ports=[{"port": 8080, "target_port": 8080}],
    replicas=1,
    resources={"cpu": "4", "mem": "4Gi"},
    envs=[
        {"name": "CIVIC_ENGAGEMENT_SITE", "value": "<site>"},
        {"name": "CIVIC_ENGAGEMENT_AUTH", "value": "pin"},          # or what the deployment chooses
        {"name": "CIVIC_ENGAGEMENT_STATE", "value": "s3://<bucket>/<prefix>/"},
        {"name": "CIVIC_ENGAGEMENT_CPUS", "value": "4"},
        {"name": "CIVIC_ENGAGEMENT_TRUSTED_PROXY", "value": "1"},   # if the gateway sets X-Forwarded-For
    ],
    secrets=["<manager>", "<pin-secret>", "<s3-credentials>"],
    run_as_user=1000, run_as_group=1000, fs_group=1000,
)
```

The SDK's `run()` returns once the run is created: wait for the state
`RUNNING` **and** a service URL (a stopped run keeps its URL in its
status), and watch for a run stuck in `PENDING` — the reason is in
`run.status.k8s["pods"][0]["status"]["containerStatuses"]`.

`run.invoke()` calls the service's internal address: it works from inside
the cluster (a platform workspace), not from a laptop. From the console,
the services view's **CLIENT** dialog does the same through the platform.

### The route

In KRM, a gateway (HTTPRoute) per site
([docs](https://scc-digitalhub.github.io/docs/0.15/tasks/services/#exposing-services-externally)):

| Field | Value |
|---|---|
| Name | `<pack>-<site>` |
| Service | the alias `s-<project>-<function>-latest`, port 8080 — not a run's own service |
| Hostname | one per site, under the instance's services domain |
| Path prefix | `/`, no rewrite |
| Authentication | None: the app does its own |

### Upgrading

1. Stop the running run.
2. Start a new run of the new image (same function, same parameters).

The new run reads the state from S3; the route follows it through the
alias; members' tokens stay valid (`CIVIC_ENGAGEMENT_PIN_SECRET`
unchanged). Stopping first means never two writers; the site is down for
the new run's start, under a minute.

### Logs and cleaning up

- A run's log: the console, on the run's page.
- Stopped runs keep their volumes (if any were asked for) until the
  administrators' policy removes them.
- A run stopped while still `PENDING` can leave its service behind: delete
  the run from the console.

## Checking an instance

On a new instance, before the first deployment, in a test project:

| Test | How | Tells |
|---|---|---|
| Non-root | `traefik/whoami` with `args=["--port", "8080"]`, without and with `run_as_user` | Whether root is refused |
| Image, resources, volume | `ghcr.io/astral-sh/uv:python3.12-bookworm-slim` with `command="sh"`, a script writing to a volume and serving it with `python -m http.server 8080`; `resources` 4 CPU / 4 GiB | Pulling from GHCR, the quota, the volume's lifetime (stop/resume, new run), `nproc` |
| Environment | the same, printing `env` names only, then the values of `AWS_CREDENTIALS_EXPIRATION`, `DHCORE_EXPIRES_IN`, `S3_BUCKET`, `DHCORE_VERSION` | The credentials and how long they last; the core's version |
| S3 | the same, `uv run --with boto3` writing and reading an object under the project's prefix | Access to the bucket; the internet from the cluster |
| Gateway | a route to whoami's alias; from outside: `curl $H/` (the `X-Forwarded-For` header), `curl "$H/data?size=5000000"`, `curl "$H/?wait=40s"` and longer, a new run behind the same route | The client's IP, response size, the timeout, the alias across runs |

Questions for the instance's administrators:

- the role or schemas for gateway routes in KRM, the services domain, its
  certificate;
- the gateway's timeout and size limits, and whether it sets
  `X-Forwarded-For`;
- the recommended long-term storage for a long-running service, and its
  credentials;
- whether runs' volumes are removed with the run;
- the SDK version matching the core.
