"""Minimum-time motorcycle OCP, CasADi direct collocation (spec v2 §2.10, plan W5 Task 5.2).

Model (Perantoni & Limebeer curvilinear form, reduced to a rolling point mass)
------------------------------------------------------------------------------
Independent variable: arc length ``s`` along the track CENTERLINE (closed loop).

    states   n   lateral offset from the centerline, m (left +)
             ξ   heading error relative to the centerline tangent, rad
             v   speed, m/s
             φ   roll angle, rad (left +) -- the IDEAL lean, tan φ = a_y / g
             φ̇   roll rate, rad/s
    controls a_x  longitudinal TYRE acceleration, m/s² (drive +, brake −)
             φ̈   roll acceleration, rad/s²

    S_f   = dt/ds = (1 − n·κ_c) / (v·cos ξ)
    dn/ds = (1 − n·κ_c)·tan ξ
    dξ/ds = S_f · g·tan φ / v − κ_c          (yaw rate of a steady-lean bike, Ω = a_y/v)
    dv/ds = S_f · (a_x − loss(v))            (loss = ½ρ·CdA·v²/m + rolling, as solver.ts)
    dφ/ds = S_f · φ̇,   dφ̇/ds = S_f · φ̈

Constraints at every node (spec v2 §2.1-2.2, R1 §3.1-3.3):
    corridor      −rightM ≤ n ≤ leftM        (the client sends bounds that already
                                              include the bike half width and kerb margin)
    friction      (a_x/(μx·g))² + (tan φ/μy)² ≤ 1    μx = (muX ?? mu)·gripScale, μy = mu·gripScale
                  (the IDEAL rider: allowed slip s = 1, no g(s) scaling)
    wheelie       a_x ≤ g·b / h_φ           h_φ = t + (h − t)·cos φ
    stoppie       −a_x ≤ g·(p − b) / h_φ    (tyre share; drag is added on top by the dynamics)
    power         a_x·v ≤ P/m
    lean          |φ| ≤ φ_i,max, the ideal lean whose crown + hang-off corrected BIKE lean
                  is maxLeanDeg (R1 §3.2, inverted by bisection)
    roll rate     |φ̇| ≤ max((β0 + β1·v)/g · cos²φ, 0.05)   Biniewicz lateral-jerk bound,
                  β0 = 23.5 m/s³, β1 = −0.31 1/s² -- thesis values, "doğrulanmadı"
                  (the paper gives 32.56; R1 §3.3)
    periodic      x(L) = x(0)

Wheelie/stoppie in TYRE-acceleration form: drag acts at roughly the CG height, so
inertia + drag = tyre force and the front-unload condition N_f ≥ 0 reduces to
a_x,tyre ≤ g·b/h_φ (and N_r ≥ 0 to −a_x,tyre ≤ g·(p−b)/h_φ). This is the same
limit as R1 §3.1 with h_D = h, expressed on the control rather than on the net
acceleration.

Objective ∫ S_f ds (lap time) + a tiny φ̈² / Δa_x² regulariser so the controls
do not chatter between collocation nodes (it moves the lap time by < 0.1 %).

Discretisation: trapezoidal collocation on N uniform nodes, N ≈ L / 2 m capped at
MAX_NODES (longer tracks are subsampled). IPOPT (bundled with CasADi, MUMPS),
max_iter 3000, warm-started from a numpy forward-backward QSS speed profile on the
centerline.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Callable, Optional

import numpy as np

G = 9.81
RHO = 1.225          # air density, kg/m³ -- same as solver.ts
ROLLING = 0.15       # rolling + driveline losses as a deceleration, m/s² -- same as solver.ts
V_MIN = 2.0
V_MAX = 120.0
EARTH_R = 6371008.8

NODE_SPACING_M = 2.0
MAX_NODES = 2000
MIN_NODES = 40

# Biniewicz lateral-jerk roll-rate bound, thesis values, "doğrulanmadı" (paper: 32.56).
BINIEWICZ_BETA0 = 23.5    # m/s³
BINIEWICZ_BETA1 = -0.31   # 1/s²
ROLL_RATE_FLOOR = 0.05    # rad/s

# Total width of the moving-average curvature smoother, metres (öneri: removes
# centerline sampling noise without flattening a 15 m hairpin).
CURV_SMOOTH_M = 10.0

# Optimisation scaling: v in units of V_REF, a_x in g.
V_REF = 30.0
# Regulariser weights (öneri; chosen so the lap time moves by < 0.1 %).
W_PHIDD = 1e-5
W_DAX = 1e-3


# --------------------------------------------------------------------------- #
# Parameters                                                                  #
# --------------------------------------------------------------------------- #

def bike_lean(phi_i: float, h: float, t: float, e: float) -> float:
    """Bike lean for ideal lean ``phi_i`` with tyre crown ``t`` and CG offset ``e`` (R1 §3.2)."""
    R = math.hypot(h - t, e)
    if R <= 1e-9:
        return phi_i
    return phi_i + math.asin(max(-1.0, min(1.0, t * math.sin(phi_i) / R))) - math.atan2(e, h - t)


def ideal_lean_limit(max_bike_lean: float, h: float, t: float, e: float) -> float:
    """Ideal lean whose bike lean equals ``max_bike_lean``; bisection (monotone)."""
    lo, hi = 0.0, math.radians(80.0)
    if bike_lean(hi, h, t, e) <= max_bike_lean:
        return hi
    if bike_lean(lo, h, t, e) >= max_bike_lean:
        return lo
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        if bike_lean(mid, h, t, e) < max_bike_lean:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def roll_rate_bound(v: float, phi: float) -> float:
    """Biniewicz roll-rate bound, rad/s (β values "doğrulanmadı")."""
    return max((BINIEWICZ_BETA0 + BINIEWICZ_BETA1 * v) / G * math.cos(phi) ** 2, ROLL_RATE_FLOOR)


@dataclass
class Params:
    power_w: float
    m: float
    cdA: float
    p: float          # wheelbase
    h: float          # CG height upright
    b: float          # rear contact → CG
    t: float          # tyre crown radius
    e: float          # hang-off CG offset, m_r·d_r/m
    mu_x: float
    mu_y: float
    phi_max: float    # ideal-lean limit, rad

    @classmethod
    def from_payload(cls, machine: dict, tyre: dict) -> "Params":
        m = float(machine["massKg"])
        p = float(machine.get("wheelbaseM", 1.4))
        h = float(machine.get("cgHeightM", 0.56))
        b = machine.get("cgRearM")
        b = p / 2 if b is None else float(b)
        b = min(max(b, 0.2 * p), 0.8 * p)
        t = min(float(machine.get("tyreCrownM", 0.08)), 0.9 * h)
        e = float(machine.get("riderMassKg", 75.0)) * float(machine.get("hangOffM", 0.0)) / m
        scale = float(tyre.get("gripScale", 1.0))
        mu = float(tyre["mu"])
        mu_x = tyre.get("muX")
        mu_x = mu if mu_x is None else float(mu_x)
        phi_max = ideal_lean_limit(math.radians(float(tyre["maxLeanDeg"])), h, t, e)
        return cls(
            power_w=float(machine["powerKw"]) * 1000.0,
            m=m,
            cdA=float(machine.get("cdA", 0.34)),
            p=p, h=h, b=b, t=t, e=e,
            mu_x=mu_x * scale,
            mu_y=mu * scale,
            phi_max=phi_max,
        )


def loss_decel(prm: Params, v):
    return 0.5 * RHO * prm.cdA * np.asarray(v) ** 2 / prm.m + ROLLING


def top_speed(prm: Params) -> float:
    lo, hi = V_MIN, V_MAX
    if prm.power_w >= 0.5 * RHO * prm.cdA * hi ** 3 + prm.m * ROLLING * hi:
        return hi
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if 0.5 * RHO * prm.cdA * mid ** 3 + prm.m * ROLLING * mid > prm.power_w:
            hi = mid
        else:
            lo = mid
    return lo


# --------------------------------------------------------------------------- #
# Geometry                                                                    #
# --------------------------------------------------------------------------- #

def lnglat_to_xy(lnglat: np.ndarray) -> np.ndarray:
    """Equirectangular projection around the mean latitude, metres (x east, y north)."""
    lnglat = np.asarray(lnglat, dtype=float)
    lat0 = math.radians(float(lnglat[:, 1].mean()))
    lng0 = float(lnglat[:, 0].mean())
    k = math.pi / 180 * EARTH_R
    return np.c_[(lnglat[:, 0] - lng0) * k * math.cos(lat0), (lnglat[:, 1] - lnglat[:, 1].mean()) * k]


def closed_arclength(xy: np.ndarray) -> tuple[np.ndarray, float]:
    """Cumulative arc length at each vertex (from 0) and the closed-loop length."""
    seg = np.linalg.norm(np.diff(np.vstack([xy, xy[:1]]), axis=0), axis=1)
    s = np.concatenate([[0.0], np.cumsum(seg[:-1])])
    return s, float(seg.sum())


def periodic_interp(s_query: np.ndarray, s: np.ndarray, vals: np.ndarray, length: float) -> np.ndarray:
    s_ext = np.concatenate([s, [length]])
    v_ext = np.concatenate([vals, vals[:1]])
    return np.interp(np.mod(s_query, length), s_ext, v_ext)


def resample_closed(xy: np.ndarray, n: int) -> tuple[np.ndarray, np.ndarray, float]:
    """``n`` points uniformly spaced along the closed polyline ``xy``."""
    s, length = closed_arclength(xy)
    s_new = np.linspace(0.0, length, n, endpoint=False)
    x = periodic_interp(s_new, s, xy[:, 0], length)
    y = periodic_interp(s_new, s, xy[:, 1], length)
    return np.c_[x, y], s_new, length


def curvature_closed(xy: np.ndarray, ds: float, smooth_m: float = CURV_SMOOTH_M) -> np.ndarray:
    """Signed curvature (left +) of a uniformly sampled closed polyline, smoothed."""
    d = np.diff(np.vstack([xy, xy[:1]]), axis=0)
    heading = np.arctan2(d[:, 1], d[:, 0])                  # segment i → i+1
    dtheta = np.angle(np.exp(1j * (heading - np.roll(heading, 1))))
    k = dtheta / ds                                          # at vertex i
    # Two passes of a `smooth_m` moving average (a triangular window): one pass
    # leaves a ±2.5 % ripple where a polyline is resampled at a spacing that
    # beats against its original vertex spacing; two bring it under 1 %.
    half = int(round(0.5 * smooth_m / ds))
    if half > 0:
        w = 2 * half + 1
        box = np.ones(w) / w
        for _ in range(2):
            k = np.convolve(np.concatenate([k[-half:], k, k[:half]]), box, mode="valid")
    return k


def node_count(length_m: float) -> int:
    return int(min(MAX_NODES, max(MIN_NODES, round(length_m / NODE_SPACING_M))))


# --------------------------------------------------------------------------- #
# QSS warm start                                                              #
# --------------------------------------------------------------------------- #

def qss_speed(kappa: np.ndarray, ds: float, prm: Params) -> np.ndarray:
    """Periodic forward-backward quasi-steady-state speed profile on a curvature profile."""
    n = len(kappa)
    a_lat = G * min(prm.mu_y, math.tan(prm.phi_max))
    ak = np.maximum(np.abs(kappa), 1e-9)
    vmax = np.minimum(np.sqrt(a_lat / ak), top_speed(prm))
    vmax = np.clip(vmax, V_MIN, V_MAX)
    start = int(np.argmin(vmax))
    order = (start + np.arange(n + 1)) % n

    def frac(v, k):
        ay = v * v * abs(k)
        return math.sqrt(max(0.0, 1.0 - (ay / (prm.mu_y * G)) ** 2))

    a_wheelie = G * prm.b / prm.h
    a_stoppie = G * (prm.p - prm.b) / prm.h

    v = vmax.copy()
    for j in range(1, n + 1):           # forward: drive
        i, ip = order[j], order[j - 1]
        vp = v[ip]
        drive = min(prm.power_w / (prm.m * max(vp, V_MIN)), prm.mu_x * G * frac(vp, kappa[ip]), a_wheelie)
        net = drive - float(loss_decel(prm, vp))
        v[i] = min(v[i], math.sqrt(max(V_MIN ** 2, vp * vp + 2 * ds * net)))
    for j in range(n - 1, -1, -1):      # backward: brake
        i, inx = order[j], order[j + 1]
        vn = v[inx]
        brake = min(prm.mu_x * G * frac(vn, kappa[inx]), a_stoppie) + float(loss_decel(prm, vn))
        v[i] = min(v[i], math.sqrt(vn * vn + 2 * ds * brake))
    return v


def lap_time(v: np.ndarray, ds: float) -> float:
    return float(np.sum(2 * ds / (v + np.roll(v, -1))))


# --------------------------------------------------------------------------- #
# OCP                                                                          #
# --------------------------------------------------------------------------- #

def _solve_nodes(
    kappa: np.ndarray,
    ds: float,
    left: np.ndarray,
    right: np.ndarray,
    prm: Params,
    v0: np.ndarray,
    max_wall_s: Optional[float],
) -> dict:
    import casadi as ca

    N = len(kappa)
    x = ca.SX.sym("x", 5)
    u = ca.SX.sym("u", 2)
    k = ca.SX.sym("k")
    n_, xi, vs, phi, phid = x[0], x[1], x[2], x[3], x[4]
    v = vs * V_REF
    ax = u[0] * G
    phidd = u[1]
    one_nk = 1 - n_ * k
    sf = one_nk / (v * ca.cos(xi))
    loss = 0.5 * RHO * prm.cdA * v ** 2 / prm.m + ROLLING
    f = ca.vertcat(
        one_nk * ca.tan(xi),
        sf * G * ca.tan(phi) / v - k,
        sf * (ax - loss) / V_REF,
        sf * phid,
        sf * phidd,
    )
    h_phi = prm.t + (prm.h - prm.t) * ca.cos(phi)
    rr = ca.fmax((BINIEWICZ_BETA0 + BINIEWICZ_BETA1 * v) / G * ca.cos(phi) ** 2, ROLL_RATE_FLOOR)
    gp = ca.vertcat(
        (u[0] / prm.mu_x) ** 2 + (ca.tan(phi) / prm.mu_y) ** 2,     # ≤ 1   friction ellipse
        u[0] * h_phi - prm.b,                                       # ≤ 0   wheelie (÷g)
        -u[0] * h_phi - (prm.p - prm.b),                            # ≤ 0   stoppie (÷g)
        u[0] * vs - prm.power_w / (prm.m * G * V_REF),              # ≤ 0   power (scaled)
        (phid / rr) ** 2,                                           # ≤ 1   roll rate
        one_nk,                                                     # ≥ 0.2
    )
    F = ca.Function("F", [x, u, k], [f, sf, gp])

    # MX decision variables over the SX node function mapped N times: the NLP
    # graph stays one `map` call instead of N inlined copies. Measured on this
    # Mac (2000 nodes): peak RSS 175 MB vs 278 MB with all-SX, and faster.
    X = ca.MX.sym("X", 5, N)
    U = ca.MX.sym("U", 2, N)
    fk, sfk, gk = F.map(N)(X, U, ca.DM(kappa).T)
    nxt = list(range(1, N)) + [0]
    defect = X[:, nxt] - X - 0.5 * ds * (fk + fk[:, nxt])
    dax = U[0, nxt] - U[0, :]
    J = ds * ca.sum2(sfk) + W_PHIDD * ds * ca.sumsqr(U[1, :]) + W_DAX * ca.sumsqr(dax) / ds

    w = ca.vertcat(ca.vec(X), ca.vec(U))
    g = ca.vertcat(ca.vec(defect), ca.vec(gk))
    n_gp = gk.shape[0]

    inf = np.inf
    lbx_x = np.zeros((5, N))
    ubx_x = np.zeros((5, N))
    lbx_x[0], ubx_x[0] = -right, left
    lbx_x[1], ubx_x[1] = -1.0, 1.0
    lbx_x[2], ubx_x[2] = V_MIN / V_REF, V_MAX / V_REF
    lbx_x[3], ubx_x[3] = -prm.phi_max, prm.phi_max
    lbx_x[4], ubx_x[4] = -3.0, 3.0
    lbx_u = np.zeros((2, N))
    ubx_u = np.zeros((2, N))
    lbx_u[0], ubx_u[0] = -3.0, 3.0
    lbx_u[1], ubx_u[1] = -30.0, 30.0
    lbx = np.concatenate([lbx_x.flatten(order="F"), lbx_u.flatten(order="F")])
    ubx = np.concatenate([ubx_x.flatten(order="F"), ubx_u.flatten(order="F")])

    lbg_p = np.tile(np.array([-inf, -inf, -inf, -inf, -inf, 0.2]), (N, 1)).T
    ubg_p = np.tile(np.array([1.0, 0.0, 0.0, 0.0, 1.0, inf]), (N, 1)).T
    assert lbg_p.shape[0] == n_gp
    lbg = np.concatenate([np.zeros(5 * N), lbg_p.flatten(order="F")])
    ubg = np.concatenate([np.zeros(5 * N), ubg_p.flatten(order="F")])

    # warm start from the QSS profile on the centerline
    phi0 = np.clip(np.arctan(v0 ** 2 * kappa / G), -0.98 * prm.phi_max, 0.98 * prm.phi_max)
    phid0 = v0 * (np.roll(phi0, -1) - np.roll(phi0, 1)) / (2 * ds)
    dvds = (np.roll(v0, -1) - np.roll(v0, 1)) / (2 * ds)
    ax0 = np.clip(v0 * dvds + loss_decel(prm, v0), -0.9 * prm.mu_x * G, 0.9 * prm.mu_x * G)
    x0_x = np.vstack([np.zeros(N), np.zeros(N), v0 / V_REF, phi0, phid0])
    x0_u = np.vstack([ax0 / G, np.zeros(N)])
    x0 = np.concatenate([x0_x.flatten(order="F"), x0_u.flatten(order="F")])
    x0 = np.clip(x0, lbx, ubx)

    opts = {
        "ipopt.max_iter": 3000,
        "ipopt.tol": 1e-6,
        "ipopt.acceptable_tol": 1e-4,
        "ipopt.print_level": 0,
        "ipopt.mu_strategy": "adaptive",
        "ipopt.nlp_scaling_method": "gradient-based",
        "print_time": False,
    }
    if max_wall_s is not None:
        opts["ipopt.max_wall_time"] = float(max(1.0, max_wall_s))
    solver = ca.nlpsol("ocp", "ipopt", {"x": w, "f": J, "g": g}, opts)
    sol = solver(x0=x0, lbx=lbx, ubx=ubx, lbg=lbg, ubg=ubg)
    stats = solver.stats()
    wopt = np.asarray(sol["x"]).ravel()
    Xo = wopt[: 5 * N].reshape((5, N), order="F")
    Uo = wopt[5 * N:].reshape((2, N), order="F")
    return {"X": Xo, "U": Uo, "status": stats.get("return_status", "?"),
            "success": bool(stats.get("success", False)), "iterations": int(stats.get("iter_count", -1))}


def solve_request(payload: dict, progress: Optional[Callable[[float], None]] = None,
                  timeout_s: Optional[float] = None) -> dict:
    """Solve the OCP for a validated `/ocp/jobs` body. Returns arrays at the centerline vertices."""
    t_start = time.monotonic()
    report = progress or (lambda _f: None)
    cl = np.asarray(payload["centerline"], dtype=float)
    left_v = np.asarray(payload["leftM"], dtype=float)
    right_v = np.asarray(payload["rightM"], dtype=float)
    prm = Params.from_payload(payload["machine"], payload["tyre"])

    xy = lnglat_to_xy(cl)
    s_vert, length = closed_arclength(xy)
    N = node_count(length)
    xy_n, s_n, _ = resample_closed(xy, N)
    ds = length / N
    kappa = curvature_closed(xy_n, ds)
    left = periodic_interp(s_n, s_vert, left_v, length)
    right = periodic_interp(s_n, s_vert, right_v, length)
    # keep 1 − n·κ ≥ 0.2 reachable at the bounds (offset past the local centre of curvature)
    lim = 0.8 / np.maximum(np.abs(kappa), 1e-9)
    left = np.where(kappa > 0, np.minimum(left, lim), left)
    right = np.where(kappa < 0, np.minimum(right, lim), right)
    report(0.05)

    v0 = qss_speed(kappa, ds, prm)
    qss_lap = lap_time(v0, ds)
    report(0.1)

    budget = None if timeout_s is None else timeout_s - (time.monotonic() - t_start) - 5.0
    out = _solve_nodes(kappa, ds, left, right, prm, v0, budget)
    ok_status = {"Solve_Succeeded", "Solved_To_Acceptable_Level"}
    if out["status"] not in ok_status:
        raise RuntimeError(f"IPOPT did not converge: {out['status']} after {out['iterations']} iterations")
    X = out["X"]
    n_opt, xi_opt, v_opt = X[0], X[1], X[2] * V_REF
    sf = (1 - n_opt * kappa) / (v_opt * np.cos(xi_opt))
    # trapezoid, the same quadrature the objective used
    lap = float(0.5 * ds * np.sum(sf + np.roll(sf, -1)))
    if not (np.all(np.isfinite(X)) and math.isfinite(lap)):
        raise RuntimeError("OCP returned non-finite values")
    report(1.0)
    return {
        "offsetsM": [float(a) for a in periodic_interp(s_vert, s_n, n_opt, length)],
        "vMs": [float(a) for a in periodic_interp(s_vert, s_n, v_opt, length)],
        "lapTimeS": lap,
        "iterations": out["iterations"],
        "status": out["status"],
        "nodes": N,
        "qssLapTimeS": qss_lap,
        "solveTimeS": time.monotonic() - t_start,
    }
