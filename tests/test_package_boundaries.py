"""The core must not import the domain packs (packs/), neither the backend
(civic_engagement) nor the frontend (frontend/src): they are going to
separate repositories, and each pack app is built on top of the core, never
the other way round."""

import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORE = ROOT / "civic_engagement"
PACKS = {"bologna_civic_dt", "rural_digital_twin"}
FRONTEND_CORE = ROOT / "frontend" / "src"
FRONTEND_PACKS = {"bologna-civic-dt", "rural-digital-twin"}
# Static imports, `export ... from`, dynamic imports and `new URL(...)`.
TS_SPECIFIER = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(?\s*|new URL\(\s*)["']([^"']+)["']""")


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


def test_frontend_core_does_not_import_packs():
    found = {}
    for path in sorted([*FRONTEND_CORE.rglob("*.ts"), *FRONTEND_CORE.rglob("*.tsx")]):
        specifiers = {
            spec
            for spec in TS_SPECIFIER.findall(path.read_text())
            if spec.split("/")[0] in FRONTEND_PACKS or "packs/" in spec
        }
        if specifiers:
            found[path.relative_to(ROOT).as_posix()] = specifiers
    assert found == {}


# Each pack's folder, its Python package and its npm package.
PACK_DIRS = {
    "bologna-civic-dt": "bologna_civic_dt",
    "rural-digital-twin": "rural_digital_twin",
}


def test_packs_do_not_import_each_other():
    found = {}
    for folder, package in PACK_DIRS.items():
        others = {p for p in PACKS if p != package}
        others_npm = {n for n in FRONTEND_PACKS if n != folder}
        pack = ROOT / "packs" / folder
        for path in sorted(pack.glob(f"{package}/**/*.py")):
            imports = {m for m in _pack_imports(path) if m.split(".")[0] in others}
            if imports:
                found[path.relative_to(ROOT).as_posix()] = imports
        for path in sorted([*pack.glob("frontend/src/**/*.ts"), *pack.glob("frontend/src/**/*.tsx")]):
            specifiers = {s for s in TS_SPECIFIER.findall(path.read_text()) if s.split("/")[0] in others_npm}
            if specifiers:
                found[path.relative_to(ROOT).as_posix()] = specifiers
    assert found == {}
