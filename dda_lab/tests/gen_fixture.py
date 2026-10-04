#!/usr/bin/env python3
"""Reference decoder for Ducati .dda (header v4) files.

Generates tests/fixtures/sample_expected.json, the ground truth the TypeScript
decoder (src/core/ddaParser.ts) is tested against.

Run from DDA_Reader/dda_lab:
    /Users/macbookmini/projects/dda_venv/bin/python tests/gen_fixture.py
"""
import json
import os
import struct
import sys

HEADER_VERSION_OFFSET = 0x00
SIGNATURE_OFFSET = 0x02
PLACE_OFFSET = 0x2A
RIDER_OFFSET = 0x6A
ODO_OFFSET = 0xB2
CHANNEL_COUNT_OFFSET = 0x1AD
CHANNEL_TABLE_OFFSET = 0x1AE
DESCRIPTOR_SIZE = 80

# name -> (byte size, sample period in 1/100 s). Same table as dda_merge.py.
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

SIGNED = {"GPS_LON", "GPS_LAT", "GPS_ALT"}

NAME_MAP = {
    "SPEED": "speed", "RPM": "rpm", "GAS": "tps", "DIST": "dist",
    "GEAR": "gear", "PSI_LEAN_ANGLE": "lean", "TORQUE_FAST": "tq_fast",
    "TORQUE_SLOW": "tq_slow", "GPS_ALT": "gps_alt", "GPS_LON": "gps_lon",
    "GPS_LAT": "gps_lat", "LAP": "lap_mark", "INT_LAP1": "int1",
    "INT_LAP2": "int2", "TEMP": "temp", "DTC": "dtc",
}


def _cstr(data, start, limit):
    end = data.find(b"\x00", start, start + limit)
    if end < 0:
        end = start + limit
    return data[start:end].decode("latin1")


def scale(name, raw):
    if name == "SPEED":
        return raw * 0.065625
    if name == "GAS":
        return raw * 0.5
    if name == "PSI_LEAN_ANGLE":
        return raw * 0.054931640625 - 450.0
    if name in ("GPS_LON", "GPS_LAT"):
        return raw * 1e-6
    if name == "GPS_ALT":
        return raw * 0.1
    return float(raw)


def parse_dda(data):
    if len(data) < CHANNEL_TABLE_OFFSET or data[SIGNATURE_OFFSET:SIGNATURE_OFFSET + 4] != b"DDA\x00":
        raise ValueError("not a DDA file")
    version = struct.unpack_from("<H", data, HEADER_VERSION_OFFSET)[0]
    place = _cstr(data, PLACE_OFFSET, 64)
    rider = _cstr(data, RIDER_OFFSET, 64)
    odo = struct.unpack_from("<I", data, ODO_OFFSET)[0]
    count = data[CHANNEL_COUNT_OFFSET]

    descs = []
    for i in range(count):
        off = CHANNEL_TABLE_OFFSET + DESCRIPTOR_SIZE * i
        name = _cstr(data, off, 16)
        desc = _cstr(data, off + 0x16, DESCRIPTOR_SIZE - 0x16)
        unit_off = off + 0x16 + len(desc) + 1
        unit = _cstr(data, unit_off, max(0, off + DESCRIPTOR_SIZE - unit_off))
        size, period = CHANNEL_SPECS.get(name, (0, 0))
        descs.append({"name": name, "desc": desc, "unit": unit,
                      "sizeBytes": size, "periodCs": period})

    start = CHANNEL_TABLE_OFFSET + DESCRIPTOR_SIZE * count
    stream = data[start:]
    chans = [d for d in descs if d["periodCs"] > 0 and d["sizeBytes"] > 0]

    series = {d["name"]: {"t": [], "v": []} for d in chans}
    lap_events = {d["name"]: [] for d in chans if d["name"] in ("LAP", "INT_LAP1", "INT_LAP2")}

    pos = 0
    t = 0
    n = len(stream)
    done = False
    while not done:
        for d in chans:
            if t % d["periodCs"] != 0:
                continue
            size = d["sizeBytes"]
            if pos + size > n:
                done = True
                break
            chunk = stream[pos:pos + size]
            pos += size
            raw = int.from_bytes(chunk, "little", signed=d["name"] in SIGNED)
            name = d["name"]
            if name in lap_events:
                series[name]["t"].append(t / 100.0)
                series[name]["v"].append(float(raw))
                if raw != 0xFF:
                    lap_events[name].append(t / 100.0 + raw / 100.0)
            else:
                series[name]["t"].append(t / 100.0)
                series[name]["v"].append(scale(name, raw))
        if done:
            break
        t += 1

    duration = (pos // bytes_per_second(chans)) if chans else 0
    return {
        "version": version, "place": place, "rider": rider, "odo": odo,
        "descs": descs, "series": series, "lapEvents": lap_events,
        "durationS": float(duration), "bytesConsumed": pos,
    }


def bytes_per_second(chans):
    return sum(d["sizeBytes"] * (100 // d["periodCs"]) for d in chans) or 1


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    src = os.path.join(here, "..", "public", "sample", "sample_run.dda")
    with open(src, "rb") as f:
        data = f.read()
    p = parse_dda(data)

    s = p["series"]
    out = {
        "file": "sample_run.dda",
        "version": p["version"],
        "meta": {"track": p["place"], "rider": p["rider"], "odo": p["odo"]},
        "descriptorNames": [d["name"] for d in p["descs"]],
        "dataChannelNames": [NAME_MAP.get(d["name"], d["name"].lower())
                             for d in p["descs"] if d["periodCs"] > 0 and d["sizeBytes"] > 0],
        "durationS": p["durationS"],
        "bytesConsumed": p["bytesConsumed"],
        "n": {NAME_MAP.get(k, k.lower()): len(v["v"]) for k, v in s.items()},
        "speed_first100": s["SPEED"]["v"][:100],
        "speed_t_first10": s["SPEED"]["t"][:10],
        "speed_max": max(s["SPEED"]["v"]),
        "rpm_first100": s["RPM"]["v"][:100],
        "rpm_max": max(s["RPM"]["v"]),
        "lat_at3000": s["GPS_LAT"]["v"][3000],
        "lon_at3000": s["GPS_LON"]["v"][3000],
        "lat_first20": s["GPS_LAT"]["v"][:20],
        "lon_first20": s["GPS_LON"]["v"][:20],
        "alt_first20": s["GPS_ALT"]["v"][:20],
        "lean_first20": s["PSI_LEAN_ANGLE"]["v"][:20],
        "tps_first20": s["GAS"]["v"][:20],
        "gear_first20": s["GEAR"]["v"][:20],
        "dist_first20": s["DIST"]["v"][:20],
        "dist_last": s["DIST"]["v"][-1],
        "lap_raw_first20": s["LAP"]["v"][:20],
        "lap_events": p["lapEvents"]["LAP"],
        "int1_events": p["lapEvents"]["INT_LAP1"],
        "int2_events": p["lapEvents"]["INT_LAP2"],
    }
    dst = os.path.join(here, "fixtures", "sample_expected.json")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, "w") as f:
        json.dump(out, f, indent=1)
    print(f"wrote {dst}: duration {out['durationS']}s, "
          f"{len(out['dataChannelNames'])} data channels, "
          f"speed max {out['speed_max']:.2f} km/h, {len(out['lap_events'])} lap events")
    return 0


if __name__ == "__main__":
    sys.exit(main())
