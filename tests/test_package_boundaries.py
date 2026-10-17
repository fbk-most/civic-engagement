"""The core (civic_engagement) must not import the domain packs (packs/):
they are going to separate repositories, and each pack app is built on top
of the core, never the other way round.

The split is under way, so the core still imports the urban pack in a few
modules. They are listed in TEMPORARY_IMPORTS, to be emptied as the split
proceeds: a new core → pack import fails the test, and so does an entry
that is no longer needed.
"""

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORE = ROOT / "civic_engagement"
PACKS = {"bologna_civic_dt", "rural_digital_twin"}

# Core module → the pack modules it still imports.
TEMPORARY_IMPORTS: dict[str, set[str]] = {
    "civic_engagement/ingestion/build_baseline.py": {"bologna_civic_dt.trees"},
    "civic_engagement/scene.py": {
        "bologna_civic_dt.encode",
        "bologna_civic_dt.field_grid",
        "bologna_civic_dt.layout",
        "bologna_civic_dt.model",
        "bologna_civic_dt.parameters",
        "bologna_civic_dt.solar",
        "bologna_civic_dt.thermal_field",
        "bologna_civic_dt.trees",
    },
}


def _pack_imports(path: Path) -> set[str]:
    modules: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text(), filename=str(path))):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            modules.add(node.module)
    return {m for m in modules if m.split(".")[0] in PACKS}


def test_core_does_not_import_packs():
    found = {}
    for path in sorted(CORE.rglob("*.py")):
        imports = _pack_imports(path)
        if imports:
            found[path.relative_to(ROOT).as_posix()] = imports
    assert found == TEMPORARY_IMPORTS
