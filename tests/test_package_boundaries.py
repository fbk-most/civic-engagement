"""The core (civic_engagement) must not import the domain packs (packs/):
they are going to separate repositories, and each pack app is built on top
of the core, never the other way round."""

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORE = ROOT / "civic_engagement"
PACKS = {"bologna_civic_dt", "rural_digital_twin"}


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
    assert found == {}
