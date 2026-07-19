#!/usr/bin/env python3
"""
Flip a y-down 3DGS gaussian PLY (Polycam convention) upright: 180° about X.
  positions:  (x, y, z)  -> (x, -y, -z)
  normals:    (nx,ny,nz) -> (nx,-ny,-nz)
  quats wxyz: q' = q_flip x q  ->  (w',x',y',z') = (-x, w, -z, y)
  f_rest_* (SH bands 1-3) are dropped (they would need SH rotation; DC color
  is all the analyzer's renderer needs for detection).

Usage: python flip_ply_upright.py in.ply out.ply
"""
import re
import sys

import numpy as np


def main(src, dst):
    raw = open(src, "rb").read()
    hdr_end = raw.index(b"end_header\n") + len(b"end_header\n")
    hdr = raw[:hdr_end].decode("ascii")
    n = int(re.search(r"element vertex (\d+)", hdr).group(1))
    names = re.findall(r"property float (\w+)", hdr)
    if len(re.findall(r"property", hdr)) != len(names):
        sys.exit("error: non-float properties found — this script expects an all-float 3DGS ply")

    data = np.frombuffer(raw, dtype="<f4", count=n * len(names), offset=hdr_end)
    data = data.reshape(n, len(names)).copy()
    col = {name: i for i, name in enumerate(names)}

    for f in ("y", "z", "ny", "nz"):
        if f in col:
            data[:, col[f]] *= -1.0

    w, x, y, z = (data[:, col[f]].copy() for f in ("rot_0", "rot_1", "rot_2", "rot_3"))
    data[:, col["rot_0"]] = -x
    data[:, col["rot_1"]] = w
    data[:, col["rot_2"]] = -z
    data[:, col["rot_3"]] = y

    keep = [nm for nm in names if not nm.startswith("f_rest_")]
    out_hdr = (
        "ply\nformat binary_little_endian 1.0\n"
        f"element vertex {n}\n"
        + "".join(f"property float {nm}\n" for nm in keep)
        + "end_header\n"
    )
    out = data[:, [col[nm] for nm in keep]].astype("<f4")
    with open(dst, "wb") as fh:
        fh.write(out_hdr.encode("ascii"))
        fh.write(out.tobytes())
    print(f"{src} -> {dst}: {n:,} splats, kept {len(keep)}/{len(names)} fields (f_rest dropped)")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: python flip_ply_upright.py in.ply out.ply")
    main(sys.argv[1], sys.argv[2])
