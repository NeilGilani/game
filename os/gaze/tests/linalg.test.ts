import { describe, expect, it } from "vitest";
import {
  designRow,
  gaussian,
  mad,
  median,
  ridge,
  rng,
  rotationYPR,
  solve,
  standardiser,
  transpose3,
  mulMat3,
} from "../src/linalg";

describe("linear algebra", () => {
  it("solves a small system", () => {
    const x = solve(
      [
        [2, 1],
        [1, 3],
      ],
      [5, 10],
    );
    expect(x[0]).toBeCloseTo(1, 10);
    expect(x[1]).toBeCloseTo(3, 10);
  });

  it("refuses a singular system", () => {
    expect(() =>
      solve(
        [
          [1, 2],
          [2, 4],
        ],
        [1, 2],
      ),
    ).toThrow();
  });

  it("weighted ridge recovers coefficients, and weights decide which rows matter", () => {
    const rand = rng(3);
    const rows: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 200; i++) {
      const a = rand();
      const b = rand();
      rows.push([a, b]);
      y.push(2 + 3 * a - 1.5 * b);
    }
    const s = standardiser(rows);
    const w = ridge(
      rows.map((r) => designRow(r, s)),
      y,
      1e-9,
    );
    const predict = (r: number[]) => designRow(r, s).reduce((acc, v, i) => acc + v * w[i]!, 0);
    expect(predict([0.5, 0.5])).toBeCloseTo(2 + 1.5 - 0.75, 6);
    // Two contradictory rows: the heavier one wins.
    const wr = ridge([[1], [1]], [0, 10], 0, [1, 9]);
    expect(wr[0]).toBeCloseTo(9, 6);
  });

  it("robust statistics", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    const rand = rng(1);
    const xs = Array.from({ length: 5000 }, () => gaussian(rand) * 2);
    expect(mad(xs)).toBeGreaterThan(1.85);
    expect(mad(xs)).toBeLessThan(2.15);
  });

  it("rotations are orthonormal", () => {
    const r = rotationYPR(0.3, -0.2, 0.1);
    const i = mulMat3(r, transpose3(r));
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, k) => expect(i[k]).toBeCloseTo(v, 10));
  });
});
