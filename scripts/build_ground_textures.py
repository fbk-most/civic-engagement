"""One-off script: fetch the CC0 tiling ground textures the 3D view uses and
write them out small enough to vendor into the repo.

    uv run --with pillow --with requests python scripts/build_ground_textures.py

Needs network *only when regenerating*. The outputs are committed, so the app
itself never reaches out to anything at runtime.

Only the colour map is kept. The full ambientCG download is ~10 MB per material
across colour/normal/roughness/displacement/AO at 1K; the ground is seen at
grazing angles across a whole square, where a correctly world-scaled albedo
does nearly all the work and the rest mostly costs texture memory. Each map is
downscaled to 512 and saved as JPEG, which lands around 40-80 kB.
"""

import io
import zipfile
from pathlib import Path

import requests
from PIL import Image

OUTPUT_DIR = Path("frontend/public/assets/3d/ground")
SIZE_PX = 512
JPEG_QUALITY = 82

# Maps the renderer's cover/surface keys onto ambientCG asset ids.
TEXTURES = {
    "paving": "PavingStones151",
    "sett": "PavingStones128",
    "lawn": "Grass005",
    "asphalt": "Asphalt033",
    "gravel": "Gravel043",
}


def fetch_colour_map(asset_id: str) -> Image.Image:
    url = f"https://ambientcg.com/get?file={asset_id}_1K-JPG.zip"
    response = requests.get(url, timeout=180)
    response.raise_for_status()

    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = [n for n in archive.namelist() if n.endswith("_Color.jpg")]
        if not names:
            raise SystemExit(f"{asset_id}: no _Color.jpg in the archive")
        with archive.open(names[0]) as handle:
            return Image.open(io.BytesIO(handle.read())).convert("RGB")


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for key, asset_id in TEXTURES.items():
        image = fetch_colour_map(asset_id)
        image = image.resize((SIZE_PX, SIZE_PX), Image.LANCZOS)
        path = OUTPUT_DIR / f"{key}.jpg"
        image.save(path, "JPEG", quality=JPEG_QUALITY, optimize=True)
        print(f"  {key:<8} <- {asset_id:<18} {path.stat().st_size / 1e3:5.0f} kB")


if __name__ == "__main__":
    main()
