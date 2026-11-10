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
"""

import copy
import logging
import os
import sys
import threading
import time

from civic_engagement.config import cpus

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
    uvicorn.run(
        args[0],
        host=os.environ.get("CIVIC_ENGAGEMENT_HOST", "0.0.0.0"),
        port=int(os.environ.get("CIVIC_ENGAGEMENT_PORT", "8080")),
        log_config=log_config(),
    )


if __name__ == "__main__":
    main(sys.argv[1:])
