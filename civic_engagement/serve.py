"""Runs a pack's app as a container does:

    python -m civic_engagement.serve bologna_civic_dt.main:app

uvicorn, one process (the sessions live in its memory), on
`CIVIC_ENGAGEMENT_HOST`:`CIVIC_ENGAGEMENT_PORT` (0.0.0.0:8080). Before the
app loads, the native libraries' thread pools (OpenMP, OpenBLAS, MKL) are
sized to the CPUs the process may use (`config.cpus`), unless already set:
they read it once, when numpy loads.
"""

import os
import sys

from civic_engagement.config import cpus

THREAD_VARIABLES = ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS")


def main(args: list[str]) -> None:
    if len(args) != 1 or ":" not in args[0]:
        raise SystemExit(__doc__)
    for variable in THREAD_VARIABLES:
        os.environ.setdefault(variable, str(cpus()))
    import uvicorn

    uvicorn.run(
        args[0],
        host=os.environ.get("CIVIC_ENGAGEMENT_HOST", "0.0.0.0"),
        port=int(os.environ.get("CIVIC_ENGAGEMENT_PORT", "8080")),
    )


if __name__ == "__main__":
    main(sys.argv[1:])
