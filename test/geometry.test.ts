import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { fresnel } from '../src/core/math/fresnel.ts';
import { evaluateGeometry } from '../src/core/geometry/evaluate.ts';
import type { Geometry } from '../src/core/geometry/types.ts';
import { fitAlignment, fitHermiteConnector } from '../src/core/geometry/alignment.ts';
import { invertArcLength, buildArcLengthTable } from '../src/core/math/quadrature.ts';
import { normalizeAngle } from '../src/core/math/vec.ts';

/** 用 RK4 对 (x,y,θ)' = (cosθ, sinθ, c(s)) 积分作为独立参照 */
function rk4Reference(hdg: number, curv: (s: number) => number, len: number, n = 200000) {
  const h = len / n;
  let theta = hdg;
  let x = 0;
  let y = 0;
  for (let i = 0; i < n; i++) {
    const t = i * h;
    const k1t = curv(t);
    const th2 = theta + 0.5 * h * k1t;
    const k2t = curv(t + h / 2);
    const th3 = theta + 0.5 * h * k2t;
    const k3t = curv(t + h / 2);
    const th4 = theta + h * k3t;
    const k4t = curv(t + h);
    x += (h / 6) * (Math.cos(theta) + 2 * Math.cos(th2) + 2 * Math.cos(th3) + Math.cos(th4));
    y += (h / 6) * (Math.sin(theta) + 2 * Math.sin(th2) + 2 * Math.sin(th3) + Math.sin(th4));
    theta += (h / 6) * (k1t + 2 * k2t + 2 * k3t + k4t);
  }
  return { x, y, hdg: theta };
}

describe('Fresnel 积分', () => {
  test('与文献值一致', () => {
    // Abramowitz & Stegun 表值
    const cases: Array<[number, number, number]> = [
      [0.5, 0.4923442, 0.0647324],
      [1.0, 0.7798934, 0.4382591],
      [2.0, 0.4882534, 0.3434157],
      [3.0, 0.6057208, 0.4963130],
    ];
    for (const [x, c, s] of cases) {
      const r = fresnel(x);
      assert.ok(Math.abs(r.c - c) < 1e-6, `C(${x}) = ${r.c}, 期望 ${c}`);
      assert.ok(Math.abs(r.s - s) < 1e-6, `S(${x}) = ${r.s}, 期望 ${s}`);
    }
  });

  test('为奇函数', () => {
    for (const x of [0.3, 1.1, 2.7]) {
      const p = fresnel(x);
      const m = fresnel(-x);
      assert.equal(p.c, -m.c);
      assert.equal(p.s, -m.s);
    }
  });

  test('幂级数与求积在分界处连续', () => {
    // 分界为 1.8；两侧极近处的差应仅由真实导数贡献（|f'|≤1，步长 2e-9）
    const a = fresnel(1.8 - 1e-9);
    const b = fresnel(1.8 + 1e-9);
    assert.ok(Math.abs(a.c - b.c) < 1e-8);
    assert.ok(Math.abs(a.s - b.s) < 1e-8);
  });

  test('x=0 与非有限输入', () => {
    const z = fresnel(0);
    assert.equal(z.c, 0);
    assert.equal(z.s, 0);
    assert.ok(Number.isNaN(fresnel(NaN).c));
  });
});

describe('几何图元求值', () => {
  test('直线', () => {
    const g: Geometry = { type: 'line', s: 0, x: 10, y: 20, hdg: Math.PI / 6, length: 50 };
    const p = evaluateGeometry(g, 50);
    assert.ok(Math.abs(p.x - (10 + 50 * Math.cos(Math.PI / 6))) < 1e-12);
    assert.ok(Math.abs(p.y - (20 + 50 * Math.sin(Math.PI / 6))) < 1e-12);
    assert.equal(p.curvature, 0);
    assert.equal(p.hdg, Math.PI / 6);
  });

  test('圆弧与解析圆一致', () => {
    const R = 80;
    const g: Geometry = { type: 'arc', s: 0, x: 0, y: 0, hdg: 0, length: (Math.PI / 2) * R, curvature: 1 / R };
    const p = evaluateGeometry(g, g.length);
    // 起点 (0,0) 航向 +x、左转 90°：终点应为 (R, R)
    assert.ok(Math.abs(p.x - R) < 1e-9, `x=${p.x}`);
    assert.ok(Math.abs(p.y - R) < 1e-9, `y=${p.y}`);
    assert.ok(Math.abs(normalizeAngle(p.hdg - Math.PI / 2)) < 1e-12);
  });

  test('回旋线与 RK4 数值积分一致', () => {
    const cases: Array<{ cs: number; ce: number; len: number; hdg: number }> = [
      { cs: 0, ce: 1 / 200, len: 100, hdg: 0.7 },
      { cs: 0, ce: -1 / 80, len: 60, hdg: -2.1 },
      { cs: 1 / 150, ce: -1 / 90, len: 120, hdg: 1.9 },
      { cs: -1 / 500, ce: -1 / 40, len: 90, hdg: 3.0 },
    ];
    for (const c of cases) {
      const g: Geometry = {
        type: 'spiral', s: 0, x: 0, y: 0, hdg: c.hdg, length: c.len,
        curvStart: c.cs, curvEnd: c.ce,
      };
      const cDot = (c.ce - c.cs) / c.len;
      for (const frac of [0.37, 1.0]) {
        const ds = c.len * frac;
        const got = evaluateGeometry(g, ds);
        const ref = rk4Reference(c.hdg, (t) => c.cs + cDot * t, ds);
        const err = Math.hypot(got.x - ref.x, got.y - ref.y);
        assert.ok(err < 1e-8, `位置误差 ${err} 过大 (cs=${c.cs} ce=${c.ce} ds=${ds})`);
        assert.ok(Math.abs(normalizeAngle(got.hdg - ref.hdg)) < 1e-9);
      }
    }
  });

  test('等曲率回旋线退化为圆弧', () => {
    const k = 1 / 120;
    const base = { s: 0, x: 3, y: 4, hdg: 0.9, length: 88 } as const;
    const sp = evaluateGeometry({ ...base, type: 'spiral', curvStart: k, curvEnd: k }, 88);
    const ar = evaluateGeometry({ ...base, type: 'arc', curvature: k }, 88);
    assert.ok(Math.hypot(sp.x - ar.x, sp.y - ar.y) < 1e-12);
    assert.ok(Math.abs(sp.hdg - ar.hdg) < 1e-12);
  });

  test('航向导数等于曲率', () => {
    const g: Geometry = {
      type: 'spiral', s: 0, x: 0, y: 0, hdg: 0.2, length: 100, curvStart: 0, curvEnd: 1 / 60,
    };
    const h = 1e-5;
    const s0 = 43.7;
    const d = (evaluateGeometry(g, s0 + h).hdg - evaluateGeometry(g, s0 - h).hdg) / (2 * h);
    assert.ok(Math.abs(d - evaluateGeometry(g, s0).curvature) < 1e-9);
  });

  test('poly3 / paramPoly3 的弧长参数化自洽', () => {
    const list: Geometry[] = [
      { type: 'poly3', s: 0, x: 0, y: 0, hdg: 0.4, length: 100, a: 0, b: 0, c: 0.002, d: -1e-5 },
      {
        type: 'paramPoly3', s: 0, x: 0, y: 0, hdg: 0.4, length: 100,
        aU: 0, bU: 100, cU: 0, dU: 0, aV: 0, bV: 0, cV: 12, dV: -4, pRange: 'normalized',
      },
    ];
    for (const g of list) {
      const N = 40000;
      let acc = 0;
      let prev = evaluateGeometry(g, 0);
      for (let i = 1; i <= N; i++) {
        const p = evaluateGeometry(g, (g.length * i) / N);
        acc += Math.hypot(p.x - prev.x, p.y - prev.y);
        prev = p;
      }
      assert.ok(
        Math.abs(acc - g.length) / g.length < 1e-9,
        `${g.type} 弧长 ${acc} 与标称 ${g.length} 不符`,
      );
    }
  });

  test('ds 超出范围被夹紧', () => {
    const g: Geometry = { type: 'line', s: 0, x: 0, y: 0, hdg: 0, length: 10 };
    assert.equal(evaluateGeometry(g, -5).x, 0);
    assert.equal(evaluateGeometry(g, 99).x, 10);
  });

  /**
   * pRange='arcLength' 只约束 p 的取值范围是 [0,length]，不保证 p 就是弧长。
   * 曾经把 p 直接取作 ds（免反演），对 |dC/dp| ≠ 1 的曲线会让站号系统性偏移。
   *
   * 这里刻意取一条参数速度远离 1 的曲线：u(p)=1.6p 使 |dC/dp|≈1.6，
   * 若不反演，走到 ds=length 时 p 已到上界但真实弧长约为 1.6×length。
   */
  test("paramPoly3 pRange='arcLength' 仍按弧长参数化", () => {
    const length = 100;
    const g: Geometry = {
      type: 'paramPoly3', s: 0, x: 0, y: 0, hdg: 0.3, length,
      aU: 0, bU: 1.6, cU: 0, dU: 0, aV: 0, bV: 0, cV: 0.004, dV: -1e-5,
      pRange: 'arcLength',
    };

    // 逐点折线累积长度应等于标称 length
    const N = 40000;
    let acc = 0;
    let prev = evaluateGeometry(g, 0);
    for (let i = 1; i <= N; i++) {
      const p = evaluateGeometry(g, (length * i) / N);
      acc += Math.hypot(p.x - prev.x, p.y - prev.y);
      prev = p;
    }
    assert.ok(
      Math.abs(acc - length) / length < 1e-6,
      `弧长 ${acc} 与标称 ${length} 不符`,
    );

    // 中点站号处的实际弧长应为半长（免反演时这里会明显偏大）
    const mid = evaluateGeometry(g, length / 2);
    let half = 0;
    let q = evaluateGeometry(g, 0);
    for (let i = 1; i <= N / 2; i++) {
      const p = evaluateGeometry(g, (length * i) / N);
      half += Math.hypot(p.x - q.x, p.y - q.y);
      q = p;
    }
    assert.ok(Math.abs(half - length / 2) / length < 1e-6, `半程弧长 ${half}`);
    assert.ok(Number.isFinite(mid.curvature));
  });

  test("paramPoly3 两种 pRange 描述同一条曲线时结果一致", () => {
    const length = 80;
    // arcLength 版把参数缩放到 [0,length]，等价于 normalized 版的 p/length 代换
    const normalized: Geometry = {
      type: 'paramPoly3', s: 0, x: 5, y: -2, hdg: 0.7, length,
      aU: 0, bU: 80, cU: 6, dU: -3, aV: 0, bV: 0, cV: 9, dV: -4,
      pRange: 'normalized',
    };
    const scaled: Geometry = {
      type: 'paramPoly3', s: 0, x: 5, y: -2, hdg: 0.7, length,
      aU: 0, bU: 80 / length, cU: 6 / length ** 2, dU: -3 / length ** 3,
      aV: 0, bV: 0, cV: 9 / length ** 2, dV: -4 / length ** 3,
      pRange: 'arcLength',
    };

    for (const frac of [0, 0.17, 0.5, 0.83, 1]) {
      const a = evaluateGeometry(normalized, length * frac);
      const b = evaluateGeometry(scaled, length * frac);
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-7, `frac=${frac} 位置不一致`);
      assert.ok(Math.abs(a.hdg - b.hdg) < 1e-9, `frac=${frac} 航向不一致`);
      assert.ok(Math.abs(a.curvature - b.curvature) < 1e-9, `frac=${frac} 曲率不一致`);
    }
  });
});

describe('弧长反演', () => {
  test('对单位速度曲线为恒等映射', () => {
    const speed = () => 1;
    const table = buildArcLengthTable(speed, 0, 100, 32);
    for (const target of [0, 13.7, 50, 99.9, 100]) {
      assert.ok(Math.abs(invertArcLength(table, speed, target) - target) < 1e-9);
    }
  });

  test('对变速曲线满足 arclen(invert(t)) == t', () => {
    const speed = (p: number) => 1 + 0.8 * Math.sin(p * 0.1);
    const table = buildArcLengthTable(speed, 0, 50, 32);
    for (const frac of [0.1, 0.45, 0.9]) {
      const target = table.total * frac;
      const p = invertArcLength(table, speed, target);
      // 用细分梯形重新积分校验
      const n = 20000;
      let acc = 0;
      for (let i = 0; i < n; i++) {
        acc += (speed((p * i) / n) + speed((p * (i + 1)) / n)) / 2 * (p / n);
      }
      assert.ok(Math.abs(acc - target) < 1e-6, `反演误差 ${Math.abs(acc - target)}`);
    }
  });
});

describe('线形生成', () => {
  const chainIsContinuous = (gs: readonly Geometry[]): { gap: number; hdg: number; sGap: number } => {
    let gap = 0;
    let hdg = 0;
    let sGap = 0;
    for (let i = 0; i + 1 < gs.length; i++) {
      const a = gs[i]!;
      const b = gs[i + 1]!;
      const endA = evaluateGeometry(a, a.length);
      const startB = evaluateGeometry(b, 0);
      gap = Math.max(gap, Math.hypot(endA.x - startB.x, endA.y - startB.y));
      hdg = Math.max(hdg, Math.abs(normalizeAngle(endA.hdg - startB.hdg)));
      sGap = Math.max(sGap, Math.abs(a.s + a.length - b.s));
    }
    return { gap, hdg, sGap };
  };

  const cases: Array<{ name: string; pts: Array<{ x: number; y: number }> }> = [
    { name: '直角', pts: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }] },
    { name: '缓转角', pts: [{ x: 0, y: 0 }, { x: 300, y: 10 }, { x: 600, y: 40 }] },
    { name: '多折点', pts: [{ x: 0, y: 0 }, { x: 150, y: 20 }, { x: 260, y: 130 }, { x: 420, y: 100 }, { x: 520, y: 240 }] },
    { name: '小间距', pts: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }, { x: 0, y: 30 }] },
    { name: '共线', pts: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }] },
  ];

  for (const mode of ['arc', 'spiral'] as const) {
    for (const c of cases) {
      test(`${mode} 模式 · ${c.name}：链连续且端点吻合`, () => {
        const r = fitAlignment(c.pts, { mode, radius: 50, spiralLength: 30 });
        assert.ok(r.geometries.length > 0, '未生成图元');

        const cont = chainIsContinuous(r.geometries);
        assert.ok(cont.gap < 1e-8, `位置接缝 ${cont.gap}`);
        assert.ok(cont.hdg < 1e-9, `航向跳变 ${cont.hdg}`);
        assert.ok(cont.sGap < 1e-9, `s 不连续 ${cont.sGap}`);

        const first = r.geometries[0]!;
        const start = evaluateGeometry(first, 0);
        assert.ok(Math.hypot(start.x - c.pts[0]!.x, start.y - c.pts[0]!.y) < 1e-8);

        const last = r.geometries[r.geometries.length - 1]!;
        const end = evaluateGeometry(last, last.length);
        const target = c.pts[c.pts.length - 1]!;
        assert.ok(
          Math.hypot(end.x - target.x, end.y - target.y) < 1e-8,
          '终点未落在最后一个控制点上',
        );
      });
    }
  }

  test('缓和曲线模式下曲率全程连续', () => {
    const r = fitAlignment(
      [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }],
      { mode: 'spiral', radius: 50, spiralLength: 30 },
    );
    let maxJump = 0;
    for (let i = 0; i + 1 < r.geometries.length; i++) {
      const a = r.geometries[i]!;
      const b = r.geometries[i + 1]!;
      maxJump = Math.max(
        maxJump,
        Math.abs(evaluateGeometry(a, a.length).curvature - evaluateGeometry(b, 0).curvature),
      );
    }
    assert.ok(maxJump < 1e-12, `曲率跳变 ${maxJump}`);
    // 应含 line-spiral-arc-spiral-line 五段
    assert.deepEqual(
      r.geometries.map((g) => g.type),
      ['line', 'spiral', 'arc', 'spiral', 'line'],
    );
  });

  test('缓和段过长时被裁剪而非失败', () => {
    const r = fitAlignment(
      [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }],
      { mode: 'spiral', radius: 50, spiralLength: 5000 },
    );
    assert.ok(r.geometries.length > 0);
    assert.ok(chainIsContinuous(r.geometries).gap < 1e-8);
  });

  test('点数不足时返回空结果', () => {
    assert.equal(fitAlignment([], { mode: 'arc', radius: 50, spiralLength: 0 }).geometries.length, 0);
    assert.equal(
      fitAlignment([{ x: 0, y: 0 }], { mode: 'arc', radius: 50, spiralLength: 0 }).geometries.length,
      0,
    );
  });

  test('重复点被剔除', () => {
    const r = fitAlignment(
      [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }],
      { mode: 'arc', radius: 50, spiralLength: 0 },
    );
    assert.equal(r.geometries.length, 1);
    assert.equal(r.geometries[0]!.type, 'line');
  });

  test('Hermite 连接器精确满足两端位姿', () => {
    const g = fitHermiteConnector({ x: 0, y: 0 }, 0, { x: 40, y: 30 }, Math.PI / 2);
    const s = evaluateGeometry(g, 0);
    const e = evaluateGeometry(g, g.length);
    assert.ok(Math.hypot(s.x, s.y) < 1e-12);
    assert.ok(Math.abs(normalizeAngle(s.hdg)) < 1e-12);
    assert.ok(Math.hypot(e.x - 40, e.y - 30) < 1e-6, `终点偏差 ${Math.hypot(e.x - 40, e.y - 30)}`);
    assert.ok(Math.abs(normalizeAngle(e.hdg - Math.PI / 2)) < 1e-6);
  });
});
