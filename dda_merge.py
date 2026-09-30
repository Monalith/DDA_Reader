#!/usr/bin/env python3
"""
Merge several Ducati DDA (.dda, header v4) session files into one .dda file.

The output keeps the header (track, rider, channel table) of the first file and
appends the telemetry payload of every input back to back. Each payload is
trimmed to whole seconds first, because the DDA stream is time-slot packed with
no markers: every input must start exactly on a whole-second boundary or the
decoder loses sync.

CLI:
    python dda_merge.py Run010.dda Run016.dda ... -o merged.dda [--keep-order]
"""
import argparse
import os
import re
import struct
import sys
from dataclasses import dataclass, field
from typing import List

CHANNEL_TABLE_OFFSET = 0x1AE
CHANNEL_COUNT_OFFSET = 0x1AD
DESCRIPTOR_SIZE = 80

# Channel name -> (byte size, sample period in 1/100 s). From the DDA whitepaper
# (Andrew Allan, rev4) and verified against DDA+ GPS "1714" files.
CHANNEL_SPECS = {
    "ACQ": (0, 0),
    "SPEED": (2, 10), "RPM": (2, 2), "TEMP": (1, 100), "GAS": (1, 5),
    "DIST": (3, 100), "GEAR": (1, 10), "PSI_LEAN_ANGLE": (2, 5),
    "TORQUE_FAST": (1, 5), "TORQUE_SLOW": (1, 5), "DTC": (1, 5),
    "GPS_ALT": (2, 10), "GPS_LON": (4, 10), "GPS_LAT": (4, 10),
    "LAP": (1, 100), "INT_LAP1": (1, 100), "INT_LAP2": (1, 100),
    "FORK": (2, 1), "SHOCK": (2, 1), "P_FBAK": (2, 20), "P_RBAK": (2, 20),
    "F_SPD": (2, 5), "R_SPD": (2, 5), "V_BATT": (1, 20), "DQS_SW": (1, 10),
    "DTC_LEV": (1, 100), "DAS_LEV": (1, 100),
}


class MergeError(Exception):
    pass


@dataclass
class MergeReport:
    files: List[str] = field(default_factory=list)
    seconds: int = 0
    trimmed_bytes: int = 0
    output: str = ""


def _check_dda(data: bytes, name: str):
    if len(data) < CHANNEL_TABLE_OFFSET + DESCRIPTOR_SIZE or data[2:6] != b"DDA\x00":
        raise MergeError(f"{name}: not a DDA file (missing 'DDA' signature)")
    if struct.unpack_from("<H", data, 0)[0] != 4:
        raise MergeError(f"{name}: only header version 4 files are supported")


def data_start_offset(data: bytes) -> int:
    """Payload starts right after the 80-byte channel descriptors."""
    return CHANNEL_TABLE_OFFSET + DESCRIPTOR_SIZE * data[CHANNEL_COUNT_OFFSET]


def channel_names(data: bytes) -> List[str]:
    names = []
    for i in range(data[CHANNEL_COUNT_OFFSET]):
        off = CHANNEL_TABLE_OFFSET + DESCRIPTOR_SIZE * i
        names.append(data[off:off + 16].split(b"\x00")[0].decode("latin1"))
    return names


def bytes_per_second(data: bytes) -> int:
    total = 0
    for name in channel_names(data):
        if name not in CHANNEL_SPECS:
            raise MergeError(f"unknown channel '{name}': cannot compute second length")
        size, period = CHANNEL_SPECS[name]
        if period:
            total += size * (100 // period)
    return total


def _run_number(path: str) -> int:
    m = re.search(r"Run(\d+)", os.path.basename(path), re.IGNORECASE)
    return int(m.group(1)) if m else sys.maxsize


def merge_dda(paths: List[str], out_path: str, keep_order: bool = False) -> MergeReport:
    if not paths:
        raise MergeError("no input files")
    files = list(paths) if keep_order else sorted(paths, key=_run_number)

    header = None
    start = 0
    sec_len = 0
    payloads = []
    report = MergeReport(files=files, output=out_path)

    for path in files:
        name = os.path.basename(path)
        with open(path, "rb") as f:
            data = f.read()
        _check_dda(data, name)
        if header is None:
            start = data_start_offset(data)
            header = data[:start]
            sec_len = bytes_per_second(data)
        elif data[:start] [CHANNEL_TABLE_OFFSET:] != header[CHANNEL_TABLE_OFFSET:] \
                or data_start_offset(data) != start:
            raise MergeError(f"{name}: channel table differs from {os.path.basename(files[0])}")
        payload = data[start:]
        whole = len(payload) - len(payload) % sec_len
        report.trimmed_bytes += len(payload) - whole
        report.seconds += whole // sec_len
        payloads.append(payload[:whole])

    with open(out_path, "wb") as f:
        f.write(header)
        for p in payloads:
            f.write(p)
    return report


def main(argv=None):
    ap = argparse.ArgumentParser(description="Merge several Ducati .dda session files into one")
    ap.add_argument("inputs", nargs="+", help="input .dda files")
    ap.add_argument("-o", "--output", required=True, help="output .dda path")
    ap.add_argument("--keep-order", action="store_true",
                    help="keep the given order instead of sorting by Run number")
    args = ap.parse_args(argv)
    try:
        r = merge_dda(args.inputs, args.output, keep_order=args.keep_order)
    except (MergeError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    print(f"merged {len(r.files)} files -> {r.output}: {r.seconds} s "
          f"({r.seconds // 60}m {r.seconds % 60:02d}s), trimmed {r.trimmed_bytes} bytes")
    for f in r.files:
        print("  " + os.path.basename(f))
    return 0


if __name__ == "__main__":
    sys.exit(main())
