"""TEMPORARY — "same numbers" check while the model is being
restructured (see the README): what the backend serves now must match what
it served when tests/fixtures/reference/ was recorded. Remove together with the fixtures once no longer needed.

Each site runs in its own process, since the active site is fixed at
import time (see tests/reference/capture.py).
"""

import gzip
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures" / "reference"
SITES = sorted(p.name for p in FIXTURES.iterdir() if p.is_dir())
MAX_REPORTED = 20


def _differences(expected, actual, path: str = "") -> list[str]:
    if isinstance(expected, dict) and isinstance(actual, dict):
        diffs = []
        for key in sorted(expected.keys() | actual.keys()):
            if key not in actual:
                diffs.append(f"{path}/{key}: missing")
            elif key not in expected:
                diffs.append(f"{path}/{key}: unexpected")
            else:
                diffs += _differences(expected[key], actual[key], f"{path}/{key}")
        return diffs
    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            return [f"{path}: {len(expected)} items expected, {len(actual)} found"]
        diffs = []
        for i, (e, a) in enumerate(zip(expected, actual)):
            label = e.get("id", e.get("t", i)) if isinstance(e, dict) else i
            diffs += _differences(e, a, f"{path}[{label}]")
        return diffs
    return [] if expected == actual else [f"{path}: expected {expected!r}, found {actual!r}"]


@pytest.fixture(scope="module")
def captured(tmp_path_factory) -> Path:
    out = tmp_path_factory.mktemp("reference")
    for site in SITES:
        # By path: one site per process (see capture.py), from the
        # directory the tests run in, which holds data/.
        subprocess.run(
            [sys.executable, str(ROOT / "tests" / "reference" / "capture.py"), "--out", str(out)],
            env={**os.environ, "CIVIC_ENGAGEMENT_SITE": site},
            check=True,
            capture_output=True,
        )
    return out


@pytest.mark.parametrize(
    "site, session",
    [(site, p.name.removesuffix(".json.gz")) for site in SITES for p in sorted((FIXTURES / site).glob("*.json.gz"))],
)
def test_same_numbers(captured: Path, site: str, session: str) -> None:
    def load(base: Path):
        with gzip.open(base / site / f"{session}.json.gz", "rt") as f:
            return json.load(f)

    diffs = _differences(load(FIXTURES), load(captured))
    assert not diffs, f"{len(diffs)} differences, first ones:\n" + "\n".join(diffs[:MAX_REPORTED])
