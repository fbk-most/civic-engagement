"""Runs a pack's app as a container does:

    python -m civic_engagement.serve bologna_civic_dt.main:app

uvicorn, one process (the sessions live in its memory), on
`CIVIC_ENGAGEMENT_HOST`:`CIVIC_ENGAGEMENT_PORT` (0.0.0.0:8080). Before the
app loads, the native libraries' thread pools (OpenMP, OpenBLAS, MKL) are
sized to the CPUs the process may use (`config.cpus`), unless already set:
they read it once, when numpy loads.

The log, kept short (a platform's console may show only its first lines):
the windows' polls of the scene's revision, every few seconds each, are
left out of the access log; the core's own lines (`civic_engagement.*`,
INFO and above) are in, with the memory every `CIVIC_ENGAGEMENT_MEMORY_LOG_S`
seconds (600; 0: never).

Stopping: after a SIGTERM (the platform stopping the container), a clean
shutdown and the exit status of a process ended by that signal (143), as
the platform expects: uvicorn sends the signal again to itself for that,
which some containers refuse (PermissionError), and the process would end
in error. Starting: S3 credentials the platform refuses for good
(digitalhub.py), one line saying so and status 3, uvicorn's for a failed
start — not a traceback.
"""

import copy
import logging
import os
import sys
import threading
import time

from civic_engagement.config import cpus

log = logging.getLogger("civic_engagement.serve")
# uvicorn's exit status for an app that failed to start.
STARTUP_FAILURE = 3

QUIET_PATHS = ("/api/session/revision",)


class QuietPolls(logging.Filter):
    """Leaves the polls (`QUIET_PATHS`) out of uvicorn's access log."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        path = args[2] if isinstance(args, tuple) and len(args) > 2 else ""
        return not str(path).startswith(QUIET_PATHS)


def log_config() -> dict:
    """uvicorn's logging, with the polls left out and the core's lines in."""
    import uvicorn.config

    config = copy.deepcopy(uvicorn.config.LOGGING_CONFIG)
    config.setdefault("filters", {})["quiet_polls"] = {"()": QuietPolls}
    config["handlers"]["access"]["filters"] = ["quiet_polls"]
    config["loggers"]["civic_engagement"] = {"handlers": ["default"], "level": "INFO", "propagate": False}
    return config


def log_memory_every(seconds: float) -> None:
    from civic_engagement.fields import log_memory

    def loop() -> None:
        while True:
            time.sleep(seconds)
            log_memory("running")

    threading.Thread(target=loop, name="memory-log", daemon=True).start()

THREAD_VARIABLES = ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS")


def main(args: list[str]) -> None:
    if len(args) != 1 or ":" not in args[0]:
        raise SystemExit(__doc__)
    for variable in THREAD_VARIABLES:
        os.environ.setdefault(variable, str(cpus()))
    import uvicorn

    every = float(os.environ.get("CIVIC_ENGAGEMENT_MEMORY_LOG_S", "600"))
    if every > 0:
        log_memory_every(every)
    config = uvicorn.Config(
        args[0],
        host=os.environ.get("CIVIC_ENGAGEMENT_HOST", "0.0.0.0"),
        port=int(os.environ.get("CIVIC_ENGAGEMENT_PORT", "8080")),
        log_config=log_config(),
    )
    sys.exit(serve(config))


def serve(config) -> int:
    """uvicorn.run's single process, with the exits above: the exit status."""
    import uvicorn

    from civic_engagement.digitalhub import CredentialsUnavailable

    try:
        config.load_app()
    except CredentialsUnavailable as error:
        log.error("Stopping: the platform refuses the run's S3 credentials (%s). "
                  "The state wasn't read; a new run is needed.", error)
        return STARTUP_FAILURE
    server = uvicorn.Server(config)
    try:
        server.run()
    except PermissionError:
        # uvicorn sending itself the signal it shut down for (see above).
        signals = getattr(server, "_captured_signals", None)
        if not server.should_exit or not signals:
            raise
        return 128 + int(signals[-1])
    except KeyboardInterrupt:
        pass
    return 0 if server.started else STARTUP_FAILURE


if __name__ == "__main__":
    main(sys.argv[1:])
