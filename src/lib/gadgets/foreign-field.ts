import {
  inverse as modInverse,
  mod,
} from '../../bindings/crypto/finite_field.js';
import { Field } from '../field.js';
import { Gates, foreignFieldAdd } from '../gates.js';
import { Provable } from '../provable.js';
import { Tuple } from '../util/types.js';
import { assert, bitSlice, exists, existsOne, toVar } from './common.js';
import {
  L,
  lMask,
  multiRangeCheck,
  L2,
  l2Mask,
  L3,
  compactMultiRangeCheck,
} from './range-check.js';

export { ForeignField, Field3, bigint3, Sign };

type Field3 = [Field, Field, Field];
type bigint3 = [bigint, bigint, bigint];
type Sign = -1n | 1n;

const ForeignField = {
  // arithmetic
  add(x: Field3, y: Field3, f: bigint) {
    return sumChain([x, y], [1n], f);
  },
  sub(x: Field3, y: Field3, f: bigint) {
    return sumChain([x, y], [-1n], f);
  },
  sumChain,

  mul(x: Field3, y: Field3, f: bigint) {
    return multiply(x, y, f);
  },
  inv(x: Field3, f: bigint) {
    return inverse(x, f);
  },
  div(x: Field3, y: Field3, f: bigint, { allowZeroOverZero = false } = {}) {
    return divide(x, y, f, allowZeroOverZero);
  },

  // helper methods
  from(x: bigint): Field3 {
    return Field3(split(x));
  },
  toBigint(x: Field3): bigint {
    return collapse(bigint3(x));
  },
};

/**
 * computes x[0] + sign[0] * x[1] + ... + sign[n-1] * x[n] modulo f
 *
 * assumes that inputs are range checked, does range check on the result.
 */
function sumChain(x: Field3[], sign: Sign[], f: bigint) {
  assert(x.length === sign.length + 1, 'inputs and operators match');

  // constant case
  if (x.every((x) => x.every((x) => x.isConstant()))) {
    let xBig = x.map(ForeignField.toBigint);
    let sum = sign.reduce((sum, s, i) => sum + s * xBig[i + 1], xBig[0]);
    return ForeignField.from(mod(sum, f));
  }

  // provable case - create chain of ffadd rows
  let result = x[0];
  for (let i = 0; i < sign.length; i++) {
    ({ result } = singleAdd(result, x[i + 1], sign[i], f));
  }
  // final zero row to hold result
  Gates.zero(...result);

  // range check result
  multiRangeCheck(...result);

  return result;
}

/**
 * core building block for non-native addition
 *
 * **warning**: this just adds the `foreignFieldAdd` row;
 * it _must_ be chained with a second row that holds the result in its first 3 cells.
 *
 * the second row could, for example, be `zero`, `foreignFieldMul`, or another `foreignFieldAdd`.
 */
function singleAdd(x: Field3, y: Field3, sign: Sign, f: bigint) {
  let f_ = split(f);

  let [r0, r1, r2, overflow, carry] = exists(5, () => {
    let x_ = bigint3(x);
    let y_ = bigint3(y);

    // figure out if there's overflow
    let r = collapse(x_) + sign * collapse(y_);
    let overflow = 0n;
    if (sign === 1n && r >= f) overflow = 1n;
    if (sign === -1n && r < 0n) overflow = -1n;
    if (f === 0n) overflow = 0n; // special case where overflow doesn't change anything

    // do the add with carry
    // note: this "just works" with negative r01
    let r01 = collapse2(x_) + sign * collapse2(y_) - overflow * collapse2(f_);
    let carry = r01 >> L2;
    r01 &= l2Mask;
    let [r0, r1] = split2(r01);
    let r2 = x_[2] + sign * y_[2] - overflow * f_[2] + carry;

    return [r0, r1, r2, overflow, carry];
  });

  foreignFieldAdd({ left: x, right: y, overflow, carry, modulus: f_, sign });

  return { result: [r0, r1, r2] satisfies Field3, overflow };
}

function multiply(a: Field3, b: Field3, f: bigint): Field3 {
  assert(f < 1n << 259n, 'Foreign modulus fits in 259 bits');

  // constant case
  if (a.every((x) => x.isConstant()) && b.every((x) => x.isConstant())) {
    let ab = ForeignField.toBigint(a) * ForeignField.toBigint(b);
    return ForeignField.from(mod(ab, f));
  }

  // provable case
  let { r01, r2, q, q2Bound } = multiplyNoRangeCheck(a, b, f);

  // limb range checks on quotient and remainder
  multiRangeCheck(...q);
  let r = compactMultiRangeCheck(r01, r2);

  // range check on q and r bounds
  // TODO: this uses one RC too many.. need global RC stack
  let r2Bound = weakBound(r2, f);
  multiRangeCheck(q2Bound, r2Bound, toVar(0n));

  return r;
}

function inverse(x: Field3, f: bigint): Field3 {
  assert(f < 1n << 259n, 'Foreign modulus fits in 259 bits');

  // constant case
  if (x.every((x) => x.isConstant())) {
    let xInv = modInverse(ForeignField.toBigint(x), f);
    assert(xInv !== undefined, 'inverse exists');
    return ForeignField.from(xInv);
  }

  // provable case
  let xInv = exists(3, () => {
    let xInv = modInverse(ForeignField.toBigint(x), f);
    return xInv === undefined ? [0n, 0n, 0n] : split(xInv);
  });
  let { r01, r2, q, q2Bound } = multiplyNoRangeCheck(x, xInv, f);

  // limb range checks on quotient and inverse
  multiRangeCheck(...q);
  multiRangeCheck(...xInv);
  // range check on q and xInv bounds
  // TODO: this uses one RC too many.. need global RC stack
  // TODO: make sure that we can just pass non-vars to multiRangeCheck() to get rid of this
  let xInv2Bound = weakBound(xInv[2], f);
  multiRangeCheck(q2Bound, xInv2Bound, new Field(0n));

  // assert r === 1
  r01.assertEquals(1n);
  r2.assertEquals(0n);

  return xInv;
}

function divide(x: Field3, y: Field3, f: bigint, allowZeroOverZero = false) {
  assert(f < 1n << 259n, 'Foreign modulus fits in 259 bits');

  // constant case
  if (x.every((x) => x.isConstant()) && y.every((x) => x.isConstant())) {
    let yInv = modInverse(ForeignField.toBigint(y), f);
    assert(yInv !== undefined, 'inverse exists');
    return ForeignField.from(mod(ForeignField.toBigint(x) * yInv, f));
  }

  // provable case
  // to show that z = x/y, we prove that z*y = x and y != 0 (the latter avoids the unconstrained 0/0 case)
  let z = exists(3, () => {
    let yInv = modInverse(ForeignField.toBigint(y), f);
    if (yInv === undefined) return [0n, 0n, 0n];
    return split(mod(ForeignField.toBigint(x) * yInv, f));
  });
  let { r01, r2, q, q2Bound } = multiplyNoRangeCheck(z, y, f);

  // limb range checks on quotient and result
  multiRangeCheck(...q);
  multiRangeCheck(...z);
  // range check on q and result bounds
  let z2Bound = weakBound(z[2], f);
  multiRangeCheck(q2Bound, z2Bound, new Field(0n));

  // check that r === x
  // this means we don't have to range check r
  let x01 = x[0].add(x[1].mul(1n << L));
  r01.assertEquals(x01);
  r2.assertEquals(x[2]);

  if (!allowZeroOverZero) {
    // assert that y != 0 mod f by checking that it doesn't equal 0 or f
    // this works because we assume y[2] <= f2
    // TODO is this the most efficient way?
    let y01 = y[0].add(y[1].mul(1n << L));
    y01.equals(0n).and(y[2].equals(0n)).assertFalse();
    let [f0, f1, f2] = split(f);
    let f01 = collapse2([f0, f1]);
    y01.equals(f01).and(y[2].equals(f2)).assertFalse();
  }

  return z;
}

function multiplyNoRangeCheck(a: Field3, b: Field3, f: bigint) {
  // notation follows https://github.com/o1-labs/rfcs/blob/main/0006-ffmul-revised.md
  let f_ = (1n << L3) - f;
  let [f_0, f_1, f_2] = split(f_);
  let f2 = f >> L2;
  let f2Bound = (1n << L) - f2 - 1n;

  let witnesses = exists(21, () => {
    // split inputs into 3 limbs
    let [a0, a1, a2] = bigint3(a);
    let [b0, b1, b2] = bigint3(b);

    // compute q and r such that a*b = q*f + r
    let ab = collapse([a0, a1, a2]) * collapse([b0, b1, b2]);
    let q = ab / f;
    let r = ab - q * f;

    let [q0, q1, q2] = split(q);
    let [r0, r1, r2] = split(r);
    let r01 = collapse2([r0, r1]);

    // compute product terms
    let p0 = a0 * b0 + q0 * f_0;
    let p1 = a0 * b1 + a1 * b0 + q0 * f_1 + q1 * f_0;
    let p2 = a0 * b2 + a1 * b1 + a2 * b0 + q0 * f_2 + q1 * f_1 + q2 * f_0;

    let [p10, p110, p111] = split(p1);
    let p11 = collapse2([p110, p111]);

    // carry bottom limbs
    let c0 = (p0 + (p10 << L) - r01) >> L2;

    // carry top limb
    let c1 = (p2 - r2 + p11 + c0) >> L;

    // split high carry
    let c1_00 = bitSlice(c1, 0, 12);
    let c1_12 = bitSlice(c1, 12, 12);
    let c1_24 = bitSlice(c1, 24, 12);
    let c1_36 = bitSlice(c1, 36, 12);
    let c1_48 = bitSlice(c1, 48, 12);
    let c1_60 = bitSlice(c1, 60, 12);
    let c1_72 = bitSlice(c1, 72, 12);
    let c1_84 = bitSlice(c1, 84, 2);
    let c1_86 = bitSlice(c1, 86, 2);
    let c1_88 = bitSlice(c1, 88, 2);
    let c1_90 = bitSlice(c1, 90, 1);

    // quotient high bound
    let q2Bound = q2 + f2Bound;

    // prettier-ignore
    return [
      r01, r2,
      q0, q1, q2,
      q2Bound,
      p10, p110, p111,
      c0,
      c1_00, c1_12, c1_24, c1_36, c1_48, c1_60, c1_72,
      c1_84, c1_86, c1_88, c1_90,
    ];
  });

  // prettier-ignore
  let [
    r01, r2,
    q0, q1, q2,
    q2Bound,
    p10, p110, p111,
    c0,
    c1_00, c1_12, c1_24, c1_36, c1_48, c1_60, c1_72,
    c1_84, c1_86, c1_88, c1_90,
  ] = witnesses;

  let q: Field3 = [q0, q1, q2];

  // ffmul gate. this already adds the following zero row.
  Gates.foreignFieldMul({
    left: a,
    right: b,
    remainder: [r01, r2],
    quotient: q,
    quotientHiBound: q2Bound,
    product1: [p10, p110, p111],
    carry0: c0,
    carry1p: [c1_00, c1_12, c1_24, c1_36, c1_48, c1_60, c1_72],
    carry1c: [c1_84, c1_86, c1_88, c1_90],
    foreignFieldModulus2: f2,
    negForeignFieldModulus: [f_0, f_1, f_2],
  });

  return { r01, r2, q, q2Bound };
}

function weakBound(x: Field, f: bigint) {
  let f2 = f >> L2;
  let f2Bound = (1n << L) - f2 - 1n;
  return x.add(f2Bound);
}

function Field3(x: bigint3): Field3 {
  return Tuple.map(x, (x) => new Field(x));
}
function bigint3(x: Field3): bigint3 {
  return Tuple.map(x, (x) => x.toBigInt());
}

function collapse([x0, x1, x2]: bigint3) {
  return x0 + (x1 << L) + (x2 << L2);
}
function split(x: bigint): bigint3 {
  return [x & lMask, (x >> L) & lMask, (x >> L2) & lMask];
}

function collapse2([x0, x1]: bigint3 | [bigint, bigint]) {
  return x0 + (x1 << L);
}
function split2(x: bigint): [bigint, bigint] {
  return [x & lMask, (x >> L) & lMask];
}
