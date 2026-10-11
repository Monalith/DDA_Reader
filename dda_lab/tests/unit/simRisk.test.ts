import { describe, expect, it } from 'vitest';
import { GRIP_WARN, gripRiskMessage } from '../../src/sim/risk';
import { solve } from '../../src/sim/solver';
import { buildLine } from '../../src/sim/line';
import { clampParams, DEFAULT_SIM_PARAMS, MACHINE_PRESETS, presetById } from '../../src/sim/presets';
import { deriveRider } from '../../src/sim/derive';
import { circuitTrack } from './circuitFixture';

const { track, corridor } = circuitTrack(6, 2, 0.25);

function peakGrip(p: ReturnType<typeof clampParams>): number {
  const env = solve(buildLine(track, corridor, p), p);
  let peak = 0;
  for (let i = 0; i < env.gripUse.length; i++) peak = Math.max(peak, env.gripUse[i]);
  return peak;
}

describe('grip risk banner', () => {
  it('does not fire on the shipped defaults', () => {
    // I1: at DEFAULT_SIM_PARAMS the banner's old 0.98 threshold saw a peak of
    // 1.0164 and 5.5 % of the lap over the line, so the panel warned "the front
    // would let go" about its own default configuration on every run. A
    // permanent false alarm is worse than no banner: it makes a real one
    // indistinguishable.
    const p = clampParams(DEFAULT_SIM_PARAMS);
    const env = solve(buildLine(track, corridor, p), p);
    expect(gripRiskMessage(env.gripUse)).toBeNull();
    // with real margin, not by a whisker — the index-stagger fix in solve()
    // brought the peak down from 1.0164 to ~1.005
    expect(peakGrip(p)).toBeLessThan(GRIP_WARN - 0.03);
  });

  it('does not fire on any shipped machine preset', () => {
    for (const preset of MACHINE_PRESETS) {
      const p = clampParams({
        machine: { presetId: preset.id, ...preset.machine },
        tyre: { ...preset.tyre },
        rider: { ...clampParams(DEFAULT_SIM_PARAMS).rider, kappa: presetById(preset.id).kappa },
      });
      const env = solve(buildLine(track, corridor, p), p);
      expect(gripRiskMessage(env.gripUse), preset.id).toBeNull();
    }
  });

  it('does not fire anywhere on the Aggressiveness x Risk grid the store derives', () => {
    // the app never runs DEFAULT_SIM_PARAMS' explicit rider: the store derives
    // every rider field from A/R, so that is the configuration to hold quiet
    for (const a of [0, 0.5, 1]) {
      for (const r of [0, 0.5, 1]) {
        const base = clampParams(DEFAULT_SIM_PARAMS);
        const p = { ...base, rider: deriveRider({ ...base.rider, aggressiveness: a, risk: r }, base.tyre) };
        const env = solve(buildLine(track, corridor, p), p);
        expect(gripRiskMessage(env.gripUse, env.gripUsePeak), `A=${a} R=${r}`).toBeNull();
      }
    }
  });

  it('fires on a genuinely over-the-limit grip trace, naming the peak and the share of the lap', () => {
    // The solver's own passes cannot produce this any more: braking is
    // friction-limited (I3) and the lateral limit caps v at sqrt(aLatMax*r), so
    // after those two fixes no parameter combination in a 225-point sweep gets
    // past 1.0072. The banner is therefore a guard on the CHANNEL, and this is
    // the channel it guards: a quarter of the lap at 1.3 of the friction
    // circle, which is the shape the mu-0.6 / brakingG-1.6 combination used to
    // produce (peak 1.65, 25 % of the lap) before braking was limited.
    const g = new Float32Array(400);
    for (let i = 0; i < g.length; i++) g[i] = i < 100 ? 1.3 : 0.5;
    const msg = gripRiskMessage(g);
    expect(msg).toBeTruthy();
    expect(msg).toContain('130 %');
    expect(msg).toContain('25 % of the lap');
    // deferred #8: the advice must not include lowering the lean usage, which
    // is inert above 0.915 on the default preset
    expect(msg!.toLowerCase()).not.toContain('lean');
    expect(msg!.toLowerCase()).toContain('trail brake depth');
  });

  it("measures the peak against the rider's own ceiling, not the tyre's", () => {
    // spec v2 §2.8: gripUse is normalised to μ_eff, so the banner speaks of the
    // rider's ceiling; without gripUsePeak it does not invent a tyre figure
    const g = new Float32Array(100).fill(0.5);
    g[3] = 1.2;
    const msg = gripRiskMessage(g)!;
    expect(msg).toContain("120 % of the rider's grip ceiling");
    expect(msg).not.toContain('of the tyre');
  });

  it('names both figures when the peak-mu channel is given', () => {
    const g = new Float32Array(100).fill(0.5);
    const gp = new Float32Array(100).fill(0.4);
    g[3] = 1.2;
    gp[3] = 0.93;
    const msg = gripRiskMessage(g, gp)!;
    expect(msg).toContain("120 % of the rider's grip ceiling (93 % of the tyre)");
    // past the rider's margin but inside the tyre: not a crash warning
    expect(msg.toLowerCase()).not.toContain('let go');
    expect(msg.toLowerCase()).toContain('risk');
  });

  it('warns that the front would let go when the tyre itself is over its peak', () => {
    const g = new Float32Array(100).fill(0.5);
    const gp = new Float32Array(100).fill(0.4);
    g[3] = 1.4;
    gp[3] = 1.12;
    const msg = gripRiskMessage(g, gp)!;
    expect(msg).toContain('(112 % of the tyre)');
    expect(msg.toLowerCase()).toContain('let go');
  });

  it('stays quiet on the rider channel alone even if the peak channel is high', () => {
    // the banner fires on the rider's ceiling; gripUsePeak only qualifies it
    const g = new Float32Array(10).fill(0.9);
    const gp = new Float32Array(10).fill(1.3);
    expect(gripRiskMessage(g, gp)).toBeNull();
  });

  it('is quiet for an empty, absent or all-NaN channel rather than reporting 0 %', () => {
    expect(gripRiskMessage(undefined)).toBeNull();
    expect(gripRiskMessage(new Float32Array(0))).toBeNull();
    expect(gripRiskMessage(new Float32Array(10).fill(NaN))).toBeNull();
  });

  it('counts the share of the lap against the same threshold as the peak', () => {
    // The old banner reported a peak against one threshold and counted samples
    // against another, and rounded the share to an integer, so one sample over
    // the line out of a thousand read as "0 % of the lap".
    const g = new Float32Array(1000).fill(0.5);
    g[0] = 1.4;
    expect(gripRiskMessage(g)).toContain('0.1 % of the lap');
  });

  it('takes the share of the lap over the samples it could read, not over the NaNs too', () => {
    // Half the channel is NaN — the stretch before the solver had a speed to
    // work with. A sample over the limit is 0.2 % of the lap that exists, not
    // 0.1 % of the array.
    const g = new Float32Array(1000).fill(Number.NaN);
    for (let i = 0; i < 500; i++) g[i] = 0.5;
    g[0] = 1.4;
    expect(gripRiskMessage(g)).toContain('0.2 % of the lap');
  });

  it('warns on a channel that is almost entirely NaN but over the limit where it is not', () => {
    const g = new Float32Array(100).fill(Number.NaN);
    g[7] = 1.6;
    const msg = gripRiskMessage(g);
    expect(msg).toContain('160 %');
    expect(msg).toContain('100 % of the lap');
  });
});
