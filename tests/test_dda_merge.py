import os
import sys
import struct

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from dda_merge import merge_dda, MergeError, data_start_offset, bytes_per_second  # noqa: E402

SAMPLE = os.path.join(ROOT, "sample_run.dda")


@pytest.fixture(scope="module")
def sample():
    with open(SAMPLE, "rb") as f:
        data = f.read()
    start = data_start_offset(data)
    return data, data[:start], data[start:]


def _write(path, header, payload):
    with open(path, "wb") as f:
        f.write(header + payload)
    return str(path)


def test_data_start_offset_from_channel_count(sample):
    data, header, _ = sample
    assert data_start_offset(data) == 430 + 80 * data[0x1AD]
    assert len(header) == 1630


def test_bytes_per_second_for_gps_channel_set(sample):
    data, _, _ = sample
    assert bytes_per_second(data) == 336


def test_merge_concatenates_whole_seconds_only(sample, tmp_path):
    _, header, payload = sample
    sec = 336
    a = _write(tmp_path / "Run001-1-00.00.dda", header, payload[: 10 * sec + 100])
    b = _write(tmp_path / "Run002-1-00.00.dda", header, payload[10 * sec : 25 * sec + 7])
    out = tmp_path / "merged.dda"

    report = merge_dda([a, b], str(out))

    merged = out.read_bytes()
    assert merged[:1630] == header
    assert merged[1630:] == payload[: 10 * sec] + payload[10 * sec : 25 * sec]
    assert report.files == [a, b]
    assert report.seconds == 25
    assert report.trimmed_bytes == 107


def test_inputs_sorted_by_run_number_by_default(sample, tmp_path):
    _, header, payload = sample
    sec = 336
    late = _write(tmp_path / "Run020-9-00.00.dda", header, payload[sec : 2 * sec])
    early = _write(tmp_path / "Run003-9-00.00.dda", header, payload[:sec])
    out = tmp_path / "m.dda"

    report = merge_dda([late, early], str(out))

    assert report.files == [early, late]
    assert out.read_bytes()[1630:] == payload[: 2 * sec]


def test_keep_order_flag_disables_sorting(sample, tmp_path):
    _, header, payload = sample
    sec = 336
    late = _write(tmp_path / "Run020-9-00.00.dda", header, payload[sec : 2 * sec])
    early = _write(tmp_path / "Run003-9-00.00.dda", header, payload[:sec])
    out = tmp_path / "m.dda"

    merge_dda([late, early], str(out), keep_order=True)

    assert out.read_bytes()[1630:] == payload[sec : 2 * sec] + payload[:sec]


def test_rejects_mismatched_channel_table(sample, tmp_path):
    _, header, payload = sample
    bad_header = bytearray(header)
    bad_header[0x1AE + 80 + 2] ^= 0xFF  # corrupt the name of the first real channel
    a = _write(tmp_path / "Run001-1-00.00.dda", header, payload[:336])
    b = _write(tmp_path / "Run002-1-00.00.dda", bytes(bad_header), payload[:336])
    out = tmp_path / "m.dda"

    with pytest.raises(MergeError) as exc:
        merge_dda([a, b], str(out))

    assert "Run002" in str(exc.value)
    assert not out.exists()


def test_rejects_non_dda_file(tmp_path):
    junk = tmp_path / "x.dda"
    junk.write_bytes(b"\x00" * 2000)
    with pytest.raises(MergeError):
        merge_dda([str(junk)], str(tmp_path / "m.dda"))


def test_merged_file_parses_with_core_parser(sample, tmp_path):
    from dda_core import DDAParser

    data, header, payload = sample
    sec = 336
    a = _write(tmp_path / "Run001-1-00.00.dda", header, payload[: 300 * sec + 50])
    b = _write(tmp_path / "Run002-1-00.00.dda", header, payload[300 * sec : 600 * sec + 9])
    out = tmp_path / "m.dda"
    merge_dda([a, b], str(out))

    # The core parser is heuristic (skips frames before the first GPS fix), so
    # compare against the same 600 s written as a single unsplit file.
    single = _write(tmp_path / "single.dda", header, payload[: 600 * sec])
    expected = DDAParser(single).parse()

    p = DDAParser(str(out))
    frames = p.parse()
    assert frames == expected
    assert frames > 5000


def test_core_parser_keeps_all_runs_across_gps_jump(sample, tmp_path):
    from dda_core import DDAParser

    _, header, payload = sample
    sec = 336
    a = _write(tmp_path / "Run001-1-00.00.dda", header, payload[: 200 * sec])
    b = _write(tmp_path / "Run002-1-00.00.dda", header, payload[600 * sec : 900 * sec])
    out = tmp_path / "m.dda"
    merge_dda([a, b], str(out))

    fa = DDAParser(a).parse()
    fb = DDAParser(b).parse()
    fm = DDAParser(str(out)).parse()
    assert fa > 1000 and fb > 1000
    assert abs(fm - (fa + fb)) <= 20
