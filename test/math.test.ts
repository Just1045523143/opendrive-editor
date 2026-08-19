/**
 * 向量与角度工具的代数性质测试。
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  add,
  angleDelta,
  angleOf,
  clamp,
  closestOnSegment,
  cross,
  distance,
  dot,
  fromAngle,
  length,
  lerp,
  lerpVec,
  normalize,
  normalizeAngle,
  normalizeAngle2Pi,
  perpLeft,
  rayIntersect,
  scale,
  sub,
  vec2,
} from '../src/core/math/vec.ts';
import {
  constPoly3,
  evalPoly3,
  evalPoly3Derivative,
  evalRecords,
  findRecordIndex,
  hermitePoly3,
} from '../src/core/math/poly.ts';
import { gaussLegendre, gaussLegendreSegmented } from '../src/core/math/quadrature.ts';

describe('向量运算', () => {
  test('加减缩放', () => {
    const a = vec2(3, 4);
    const b = vec2(1, 2);
    assert.deepEqual(add(a, b), { x: 4, y: 6 });
    assert.deepEqual(sub(a, b), { x: 2, y: 2 });
    assert.deepEqual(scale(a, 2), { x: 6, y: 8 });
  });

  test('点积与叉积', () => {
    const a = vec2(3, 0);
    const b = vec2(0, 4);
    assert.equal(dot(a, b), 0);
    assert.equal(cross(a, b), 12);
    assert.equal(cross(b, a), -12);
    // 叉积反对称
    assert.equal(cross(a, b), -cross(b, a));
  });

  test('长度与归一化', () => {
    assert.equal(length(vec2(3, 4)), 5);
    assert.equal(distance(vec2(1, 1), vec2(4, 5)), 5);
    const n = normalize(vec2(3, 4));
    assert.ok(Math.abs(length(n) - 1) < 1e-15);
    assert.ok(Math.abs(n.x - 0.6) < 1e-15);
  });

  test('零向量归一化不产生 NaN', () => {
    const n = normalize(vec2(0, 0));
    assert.equal(n.x, 0);
    assert.equal(n.y, 0);
  });

  test('左法向为逆时针 90°', () => {
    const p = perpLeft(vec2(1, 0));
    assert.ok(Math.abs(p.x) < 1e-15);
    assert.ok(Math.abs(p.y - 1) < 1e-15);
    // 与原向量正交
    assert.ok(Math.abs(dot(vec2(1, 0), p)) < 1e-15);
  });

  test('fromAngle 与 angleOf 互逆', () => {
    for (const hdg of [0, 0.7, -1.3, Math.PI / 2, 3]) {
      const v = fromAngle(hdg, 5);
      assert.ok(Math.abs(length(v) - 5) < 1e-14);
      assert.ok(Math.abs(normalizeAngle(angleOf(v) - hdg)) < 1e-14);
    }
  });

  test('插值', () => {
    assert.equal(lerp(10, 20, 0.5), 15);
    assert.deepEqual(lerpVec(vec2(0, 0), vec2(10, 20), 0.5), { x: 5, y: 10 });
  });

  test('clamp', () => {
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-5, 0, 10), 0);
    assert.equal(clamp(15, 0, 10), 10);
  });
});

describe('角度归一化', () => {
  test('归一化到 (-π, π]', () => {
    assert.ok(Math.abs(normalizeAngle(0)) < 1e-15);
    assert.ok(Math.abs(normalizeAngle(Math.PI) - Math.PI) < 1e-14);
    // -π 应折到 +π（区间为半开）
    assert.ok(Math.abs(normalizeAngle(-Math.PI) - Math.PI) < 1e-14);
    assert.ok(Math.abs(normalizeAngle(3 * Math.PI) - Math.PI) < 1e-14);
    assert.ok(Math.abs(normalizeAngle(2 * Math.PI)) < 1e-14);
  });

  test('归一化到 [0, 2π)', () => {
    assert.ok(normalizeAngle2Pi(-0.5) > 5.7);
    assert.ok(normalizeAngle2Pi(-0.5) < 6.3);
    assert.ok(Math.abs(normalizeAngle2Pi(0)) < 1e-15);
    const v = normalizeAngle2Pi(7);
    assert.ok(v >= 0 && v < 2 * Math.PI);
  });

  test('角差取短弧', () => {
    // 0.1π → -0.9π 的差恰为 -π，落在区间边界，按 (-π, π] 的约定折到 +π
    const boundary = angleDelta(0.1 * Math.PI, -0.9 * Math.PI);
    assert.ok(Math.abs(boundary - Math.PI) < 1e-14, `实际 ${boundary / Math.PI}π`);

    // 跨 ±π 边界的短弧：0.9π → -0.9π 应为 +0.2π 而非 -1.8π
    const across = angleDelta(0.9 * Math.PI, -0.9 * Math.PI);
    assert.ok(Math.abs(across - 0.2 * Math.PI) < 1e-14, `实际 ${across / Math.PI}π`);

    // 同向小角差保持原值
    assert.ok(Math.abs(angleDelta(0.2, 0.5) - 0.3) < 1e-14);
    assert.ok(Math.abs(angleDelta(0.5, 0.2) - -0.3) < 1e-14);
    // 结果始终落在 (-π, π]
    for (const [a, b] of [[0, 3], [3, 0], [-3, 3], [1, -1]] as const) {
      const delta = angleDelta(a, b);
      assert.ok(delta > -Math.PI - 1e-12 && delta <= Math.PI + 1e-12);
    }
  });
});

describe('几何辅助', () => {
  test('点到线段最近点：投影落在段内', () => {
    const r = closestOnSegment(vec2(5, 3), vec2(0, 0), vec2(10, 0));
    assert.ok(Math.abs(r.t - 0.5) < 1e-15);
    assert.deepEqual(r.point, { x: 5, y: 0 });
    assert.equal(r.dist, 3);
  });

  test('点到线段最近点：投影落在段外被夹紧', () => {
    const before = closestOnSegment(vec2(-5, 0), vec2(0, 0), vec2(10, 0));
    assert.equal(before.t, 0);
    assert.equal(before.dist, 5);

    const after = closestOnSegment(vec2(20, 0), vec2(0, 0), vec2(10, 0));
    assert.equal(after.t, 1);
    assert.equal(after.dist, 10);
  });

  test('退化线段（两点重合）不崩溃', () => {
    const r = closestOnSegment(vec2(3, 4), vec2(1, 1), vec2(1, 1));
    assert.equal(r.t, 0);
    assert.deepEqual(r.point, { x: 1, y: 1 });
    // 距离为点到该重合点的直线距离 hypot(2, 3)
    assert.ok(Math.abs(r.dist - Math.hypot(2, 3)) < 1e-14);
  });

  test('射线求交', () => {
    const p = rayIntersect(vec2(0, 0), vec2(1, 0), vec2(5, -5), vec2(0, 1));
    assert.ok(p !== null);
    assert.ok(Math.abs(p!.x - 5) < 1e-14);
    assert.ok(Math.abs(p!.y) < 1e-14);
  });

  test('平行射线返回 null', () => {
    assert.equal(rayIntersect(vec2(0, 0), vec2(1, 0), vec2(0, 5), vec2(1, 0)), null);
    assert.equal(rayIntersect(vec2(0, 0), vec2(1, 0), vec2(0, 5), vec2(-1, 0)), null);
  });
});

describe('三次多项式', () => {
  test('求值与导数', () => {
    const p = { a: 1, b: 2, c: 3, d: 4 };
    // f(2) = 1 + 4 + 12 + 32 = 49
    assert.equal(evalPoly3(p, 2), 49);
    // f'(ds) = 2 + 6ds + 12ds²，f'(2) = 2 + 12 + 48 = 62
    assert.equal(evalPoly3Derivative(p, 2), 62);
    assert.equal(evalPoly3(p, 0), 1);
  });

  test('常量多项式', () => {
    const p = constPoly3(7);
    assert.equal(evalPoly3(p, 0), 7);
    assert.equal(evalPoly3(p, 100), 7);
    assert.equal(evalPoly3Derivative(p, 50), 0);
  });

  test('Hermite 插值满足端点约束', () => {
    const len = 10;
    const p = hermitePoly3(2, 8, 0.5, -0.3, len);
    assert.ok(Math.abs(evalPoly3(p, 0) - 2) < 1e-12, '起点值');
    assert.ok(Math.abs(evalPoly3(p, len) - 8) < 1e-12, '终点值');
    assert.ok(Math.abs(evalPoly3Derivative(p, 0) - 0.5) < 1e-12, '起点斜率');
    assert.ok(Math.abs(evalPoly3Derivative(p, len) - -0.3) < 1e-12, '终点斜率');
  });

  test('零长度 Hermite 退化为常量', () => {
    const p = hermitePoly3(5, 9, 1, 2, 0);
    assert.equal(evalPoly3(p, 0), 5);
  });

  test('分段记录二分查找', () => {
    const recs = [
      { s: 0, a: 1, b: 0, c: 0, d: 0 },
      { s: 10, a: 2, b: 0, c: 0, d: 0 },
      { s: 20, a: 3, b: 0, c: 0, d: 0 },
    ];
    assert.equal(findRecordIndex(recs, -1), -1);
    assert.equal(findRecordIndex(recs, 0), 0);
    assert.equal(findRecordIndex(recs, 9.9), 0);
    assert.equal(findRecordIndex(recs, 10), 1);
    assert.equal(findRecordIndex(recs, 25), 2);
    assert.equal(findRecordIndex(recs, 1e9), 2);
  });

  test('分段记录求值', () => {
    const recs = [
      { s: 0, a: 1, b: 0, c: 0, d: 0 },
      { s: 10, a: 2, b: 1, c: 0, d: 0 },
    ];
    assert.equal(evalRecords(recs, 5), 1);
    // 第二段：ds = 15 - 10 = 5，f = 2 + 1×5 = 7
    assert.equal(evalRecords(recs, 15), 7);
    // 空序列返回 fallback
    assert.equal(evalRecords([], 5, 42), 42);
  });
});

describe('数值求积', () => {
  test('对多项式精确（16 点 GL 可积 31 次）', () => {
    // ∫₀² x³ dx = 4
    assert.ok(Math.abs(gaussLegendre((x) => x ** 3, 0, 2) - 4) < 1e-13);
    // ∫₀¹ x⁵ dx = 1/6
    assert.ok(Math.abs(gaussLegendre((x) => x ** 5, 0, 1) - 1 / 6) < 1e-15);
  });

  test('对三角函数高精度', () => {
    // ∫₀^π sin x dx = 2
    assert.ok(Math.abs(gaussLegendre(Math.sin, 0, Math.PI) - 2) < 1e-14);
  });

  test('分段求积对强振荡函数收敛', () => {
    // ∫₀^{10π} sin x dx = 0，单段 GL 会失准，分段后应精确
    const single = gaussLegendre(Math.sin, 0, 10 * Math.PI);
    const segmented = gaussLegendreSegmented(Math.sin, 0, 10 * Math.PI, 20);
    assert.ok(Math.abs(segmented) < 1e-13, `分段结果 ${segmented}`);
    assert.ok(Math.abs(segmented) < Math.abs(single) + 1e-12, '分段应不差于单段');
  });

  test('区间为零时返回零', () => {
    assert.equal(gaussLegendre((x) => x ** 2, 5, 5), 0);
  });

  test('分段数为 1 时等价于单段', () => {
    const a = gaussLegendre(Math.cos, 0, 1);
    const b = gaussLegendreSegmented(Math.cos, 0, 1, 1);
    assert.ok(Math.abs(a - b) < 1e-15);
  });
});
