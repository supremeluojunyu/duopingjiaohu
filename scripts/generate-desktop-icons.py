#!/usr/bin/env python3
"""Generate square PNG icons for electron-builder (stdlib only)."""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "desktop" / "build"
ICONS = BUILD / "icons"


def write_png(path: Path, size: int) -> None:
    cx = cy = size / 2
    outer = size * 0.46
    inner = size * 0.36

    def pixel(x: int, y: int) -> tuple[int, int, int]:
        dx, dy = x - cx + 0.5, y - cy + 0.5
        dist = (dx * dx + dy * dy) ** 0.5
        t = (x + y) / (2 * size)
        r, g, b = int(18 + 35 * t), int(24 + 55 * t), int(72 + 110 * t)

        if dist <= outer:
            r, g, b = int(36 + 40 * t), int(58 + 50 * t), int(120 + 80 * t)
        if dist <= inner:
            r, g, b = int(70 + 30 * t), int(130 + 40 * t), int(210 + 20 * t)

        bar = size * 0.07
        gap = size * 0.08
        left = cx - size * 0.16
        right = cx + size * 0.16
        top = cy - size * 0.18
        bottom = cy + size * 0.18
        mid_top = cy - gap
        mid_bot = cy + gap

        on_h = (
            left <= x < left + bar
            and top <= y < bottom
        ) or (
            right - bar <= x < right
            and top <= y < bottom
        ) or (
            left <= x < right
            and mid_top <= y < mid_top + bar
        )

        if on_h:
            return 255, 255, 255
        return r, g, b

    rows: list[bytes] = []
    for y in range(size):
        row = b"\x00"
        for x in range(size):
            row += bytes(pixel(x, y))
        rows.append(row)

    compressed = zlib.compress(b"".join(rows), 9)

    def chunk(chunk_type: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(chunk_type + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + chunk_type + data + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", compressed)
        + chunk(b"IEND", b"")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def main() -> None:
    write_png(BUILD / "icon.png", 512)
    write_png(ICONS / "512x512.png", 512)
    write_png(ICONS / "256x256.png", 256)
    for p in [BUILD / "icon.png", ICONS / "512x512.png", ICONS / "256x256.png"]:
        data = p.read_bytes()
        w, h = struct.unpack(">II", data[16:24])
        print(f"Wrote {p.relative_to(ROOT)} ({w}x{h}, {len(data)} bytes)")


if __name__ == "__main__":
    main()
