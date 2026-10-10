"""Build a fake webcam stream (Y4M) from MediaPipe's public sample portrait.

Chromium plays this file as the camera when started with
--use-file-for-fake-video-capture, so the real MediaPipe pipeline can be exercised in a
headless test. This is a TEST FIXTURE (a still photo), not live camera testing: it shows
that the camera, model loading and landmark extraction work end to end, not that gaze
estimation is accurate for a real person.

Usage: python make_fake_camera.py <output.y4m>
Downloads https://storage.googleapis.com/mediapipe-assets/portrait.jpg (cached next to the
output). Requires Pillow.
"""

from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

from PIL import Image

SOURCE = "https://storage.googleapis.com/mediapipe-assets/portrait.jpg"
WIDTH, HEIGHT, FRAMES = 640, 480, 30


def main(out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    jpg = out.with_suffix(".jpg")
    if not jpg.exists():
        urllib.request.urlretrieve(SOURCE, jpg)  # noqa: S310 - fixed https URL
    img = Image.open(jpg).convert("RGB")
    # Crop a 4:3 window around the face (the sample is a tall portrait with the face near
    # the top), then scale to the camera size.
    w, h = img.size
    target = WIDTH / HEIGHT
    if w / h > target:
        nw = int(h * target)
        img = img.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
    else:
        nh = int(w / target)
        top = int(h * 0.04)
        img = img.crop((0, top, w, top + nh))
    img = img.resize((WIDTH, HEIGHT))
    y, cb, cr = img.convert("YCbCr").split()
    cb = cb.resize((WIDTH // 2, HEIGHT // 2))
    cr = cr.resize((WIDTH // 2, HEIGHT // 2))
    frame = y.tobytes() + cb.tobytes() + cr.tobytes()
    with out.open("wb") as f:
        f.write(f"YUV4MPEG2 W{WIDTH} H{HEIGHT} F30:1 Ip A1:1 C420jpeg\n".encode())
        for _ in range(FRAMES):
            f.write(b"FRAME\n")
            f.write(frame)
    print(f"wrote {out} ({out.stat().st_size // 1024} KiB)")


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "e2e/fixtures/.cache/face.y4m"))
