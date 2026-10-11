"""Tests for the CasADi minimum-time motorcycle OCP (plan W5 Task 5.2).

The geometry / QSS tests are fast; the two full solves are marked `slow`
(deselect with `-m "not slow"`). Timings are printed (`-s` to see them).
"""
import math
import sys
import time
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ocp import ocp_motorcycle as om  # noqa: E402

LAT0, LNG0 = 41.073, 23.518
M_PER_DEG_LAT = math.pi / 180 * om.EARTH_R


def lnglat_from_xy(xy):
    """Inverse of the equirectangular projection the solver uses."""
    lat = LAT0 + xy[:, 1] / M_PER_DEG_LAT
    lng = LNG0 + xy[:, 0] / (M_PER_DEG_LAT * math.cos(math.radians(LAT0)))
    return [[float(a), float(b)] for a, b in zip(lng, lat)]


def circle_track(r, step=2.0, ccw=True):
    n = int(round(2 * math.pi * r / step))
    th = np.linspace(0, 2 * math.pi, n, endpoint=False)
    if not ccw:
        th = -th
    xy = np.c_[r * np.cos(th), r * np.sin(th)]
    return lnglat_from_xy(xy)


def synthetic_circuit(length_m=3000.0, step=2.0):
    """A closed, non-convex 3 km loop: radius modulated by a few harmonics."""
    th = np.linspace(0, 2 * math.pi, 4000, endpoint=False)
    rr = 1.0 + 0.22 * np.sin(3 * th) + 0.10 * np.cos(5 * th + 0.7) + 0.05 * np.sin(7 * th)
    xy = np.c_[rr * np.cos(th), rr * np.sin(th)]
    seg = np.linalg.norm(np.diff(np.vstack([xy, xy[:1]]), axis=0), axis=1)
    xy *= length_m / seg.sum()
    xy_res, _, _ = om.resample_closed(xy, int(length_m / step))
    return lnglat_from_xy(xy_res)


POINT_MASS = {
    "powerKw": 1.0e5, "massKg": 200.0, "riderMassKg": 0.0, "cdA": 0.0,
    "wheelbaseM": 1.4, "cgHeightM": 0.3, "cgRearM": 0.7, "tyreCrownM": 0.0, "hangOffM": 0.0,
}
SBK = {
    "powerKw": 147, "massKg": 285, "riderMassKg": 75, "cdA": 0.34, "wheelbaseM": 1.41,
    "cgHeightM": 0.55, "cgRearM": 0.691, "tyreCrownM": 0.08, "hangOffM": 0.15,
}


# --------------------------------------------------------------- geometry --

def test_projection_round_trip_and_circle_curvature():
    r = 100.0
    cl = circle_track(r)
    xy = om.lnglat_to_xy(np.asarray(cl))
    radii = np.linalg.norm(xy - xy.mean(axis=0), axis=1)
    assert np.allclose(radii, r, rtol=2e-3)
    xy_res, s, length = om.resample_closed(xy, 400)
    assert abs(length - 2 * math.pi * r) < 0.5
    k = om.curvature_closed(xy_res, length / 400)
    assert np.allclose(k, 1 / r, rtol=0.02)  # counter-clockwise = turning left = +


def test_clockwise_circle_has_negative_curvature():
    xy = om.lnglat_to_xy(np.asarray(circle_track(80.0, ccw=False)))
    xy_res, _, length = om.resample_closed(xy, 300)
    assert np.all(om.curvature_closed(xy_res, length / 300) < 0)


def test_node_count_is_about_two_metres_and_capped():
    assert om.node_count(1000.0) == 500
    assert om.node_count(10_000.0) == om.MAX_NODES == 2000


def test_ideal_lean_limit_inverts_the_crown_and_hang_off_correction():
    h, t, e = 0.55, 0.08, 75 * 0.15 / 285
    phi_max = math.radians(58)
    phi_i = om.ideal_lean_limit(phi_max, h, t, e)
    assert abs(om.bike_lean(phi_i, h, t, e) - phi_max) < 1e-6
    # no crown, no hang-off: identity
    assert abs(om.ideal_lean_limit(phi_max, h, 0.0, 0.0) - phi_max) < 1e-9


def test_roll_rate_bound_has_the_biniewicz_shape_and_floor():
    assert om.roll_rate_bound(10.0, 0.0) == pytest.approx((23.5 - 3.1) / 9.81)
    assert om.roll_rate_bound(10.0, math.radians(45)) == pytest.approx((23.5 - 3.1) / 9.81 * 0.5)
    assert om.roll_rate_bound(100.0, 0.0) == pytest.approx(0.05)


def test_qss_speed_on_a_circle_is_the_friction_limit():
    r, mu = 60.0, 1.1
    xy = om.lnglat_to_xy(np.asarray(circle_track(r)))
    xy_res, _, length = om.resample_closed(xy, 200)
    k = om.curvature_closed(xy_res, length / 200)
    prm = om.Params.from_payload(POINT_MASS, {"mu": mu, "maxLeanDeg": 70})
    v = om.qss_speed(k, length / 200, prm)
    assert np.allclose(v, math.sqrt(mu * om.G * r), rtol=0.02)


def test_qss_speed_brakes_before_and_accelerates_after_a_corner():
    # straight - tight hairpin - straight, as a curvature profile
    ds, n = 2.0, 600
    k = np.zeros(n)
    k[290:310] = 1 / 15.0
    prm = om.Params.from_payload(SBK, {"mu": 1.3, "maxLeanDeg": 56})
    v = om.qss_speed(k, ds, prm)
    assert v[300] < 16
    assert v[150] > 40 and v[450] > 40
    # deceleration on the way in is bounded by the stoppie/friction ceiling plus losses
    dvds = np.diff(v[200:295]) / ds
    assert np.all(v[201:295] * dvds >= -(1.3 * om.G + om.loss_decel(prm, v[201:295]) + 1e-6))


def test_params_defaults_and_mu_x():
    prm = om.Params.from_payload({"powerKw": 100, "massKg": 270}, {"mu": 1.3, "maxLeanDeg": 56})
    assert prm.mu_x == prm.mu_y == pytest.approx(1.3)
    assert prm.b == pytest.approx(prm.p / 2)
    prm2 = om.Params.from_payload(SBK, {"mu": 1.3, "muX": 1.1, "gripScale": 0.9, "maxLeanDeg": 56})
    assert prm2.mu_x == pytest.approx(0.99)
    assert prm2.mu_y == pytest.approx(1.17)


# ------------------------------------------------------------ full solves --

@pytest.mark.slow
def test_circle_lap_time_matches_the_analytic_limit():
    r, mu = 200.0, 1.0
    cl = circle_track(r)
    n = len(cl)
    payload = {
        "key": "circle-200",
        "centerline": cl,
        # a near-zero corridor: the analytic answer is for THIS radius
        "leftM": [0.01] * n,
        "rightM": [0.01] * n,
        "machine": POINT_MASS,
        "tyre": {"mu": mu, "maxLeanDeg": 70, "gripScale": 1.0},
    }
    t0 = time.monotonic()
    res = om.solve_request(payload)
    dt = time.monotonic() - t0
    analytic = 2 * math.pi * r / math.sqrt(mu * om.G * r)
    print(f"\n[ocp] circle r=200 m: {dt:.1f} s solve, lap {res['lapTimeS']:.3f} s "
          f"(analytic {analytic:.3f} s), {res['iterations']} iterations, {res['nodes']} nodes")
    assert dt < 60
    assert abs(res["lapTimeS"] - analytic) / analytic < 0.02
    assert len(res["offsetsM"]) == len(res["vMs"]) == n


@pytest.mark.slow
def test_three_km_circuit_solves_in_under_five_minutes():
    cl = synthetic_circuit(3000.0)
    n = len(cl)
    payload = {
        "key": "synthetic-3k",
        "centerline": cl,
        "leftM": [5.0] * n,
        "rightM": [5.0] * n,
        "machine": SBK,
        "tyre": {"mu": 1.33, "maxLeanDeg": 58, "gripScale": 1.0},
    }
    t0 = time.monotonic()
    res = om.solve_request(payload, timeout_s=300)
    dt = time.monotonic() - t0
    print(f"\n[ocp] synthetic 3 km: {dt:.1f} s solve, lap {res['lapTimeS']:.2f} s, "
          f"QSS centerline {res['qssLapTimeS']:.2f} s, {res['iterations']} iterations, "
          f"{res['nodes']} nodes")
    assert dt < 300
    off = np.asarray(res["offsetsM"])
    v = np.asarray(res["vMs"])
    assert off.shape == v.shape == (n,)
    assert np.all(np.isfinite(off)) and np.all(np.isfinite(v))
    assert np.all(off <= 5.0 + 1e-3) and np.all(off >= -5.0 - 1e-3)
    assert np.all(v > 2) and np.all(v < 120)
    assert math.isfinite(res["lapTimeS"])
    # using the width must beat riding the centerline at the QSS limit
    assert res["lapTimeS"] < res["qssLapTimeS"]
    # and it should actually use the corridor somewhere
    assert np.max(np.abs(off)) > 2.0


@pytest.mark.slow
def test_real_solver_runs_through_the_job_queue(tmp_path):
    """End to end: the bridge's queue spawns a child that imports CasADi and solves."""
    from ocp.job_queue import JobQueue

    q = JobQueue(solver_ref="ocp.ocp_motorcycle:solve_request", data_dir=tmp_path, timeout_s=120)
    try:
        cl = circle_track(50.0)
        n = len(cl)
        job_id = q.submit({
            "key": "circle-50", "centerline": cl, "leftM": [0.01] * n, "rightM": [0.01] * n,
            "machine": POINT_MASS, "tyre": {"mu": 1.2, "maxLeanDeg": 70},
        })
        t0 = time.monotonic()
        while time.monotonic() - t0 < 120:
            job = q.get(job_id)
            if job["status"] in ("done", "error"):
                break
            time.sleep(0.1)
        assert job["status"] == "done", job.get("message")
        analytic = 2 * math.pi * 50.0 / math.sqrt(1.2 * om.G * 50.0)
        assert abs(job["result"]["lapTimeS"] - analytic) / analytic < 0.02
        assert len(job["result"]["offsetsM"]) == n
    finally:
        q.shutdown()
