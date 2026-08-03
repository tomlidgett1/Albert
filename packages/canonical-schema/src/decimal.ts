const decimalPattern = /^(-?)(\d+)(?:\.(\d{1,4}))?$/;
const SCALE = BigInt(10_000);
const ZERO = BigInt(0);
const TWO = BigInt(2);

/** Exact fixed-scale decimal used for every money and quantity calculation. */
export class Decimal4 {
  readonly scaled: bigint;

  private constructor(scaled: bigint) {
    this.scaled = scaled;
  }

  static zero(): Decimal4 {
    return new Decimal4(ZERO);
  }

  static from(value: string | bigint | Decimal4): Decimal4 {
    if (value instanceof Decimal4) return value;
    if (typeof value === "bigint") return new Decimal4(value * SCALE);

    const normalized = value.trim();
    const match = decimalPattern.exec(normalized);
    if (!match) {
      throw new Error(`Invalid exact decimal: ${value}`);
    }

    const [, sign, whole, fraction = ""] = match;
    const scaled = BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, "0"));
    return new Decimal4(sign === "-" ? -scaled : scaled);
  }

  static fromScaled(scaled: bigint): Decimal4 {
    return new Decimal4(scaled);
  }

  add(other: string | bigint | Decimal4): Decimal4 {
    return new Decimal4(this.scaled + Decimal4.from(other).scaled);
  }

  subtract(other: string | bigint | Decimal4): Decimal4 {
    return new Decimal4(this.scaled - Decimal4.from(other).scaled);
  }

  multiply(other: string | bigint | Decimal4): Decimal4 {
    const rhs = Decimal4.from(other).scaled;
    return new Decimal4(divideRoundedHalfAwayFromZero(this.scaled * rhs, SCALE));
  }

  divide(other: string | bigint | Decimal4): Decimal4 {
    const divisor = Decimal4.from(other).scaled;
    if (divisor === ZERO) throw new Error("Cannot divide an exact decimal by zero.");
    return new Decimal4(divideRoundedHalfAwayFromZero(this.scaled * SCALE, divisor));
  }

  abs(): Decimal4 {
    return this.scaled < ZERO ? new Decimal4(-this.scaled) : this;
  }

  equals(other: string | bigint | Decimal4): boolean {
    return this.scaled === Decimal4.from(other).scaled;
  }

  compare(other: string | bigint | Decimal4): -1 | 0 | 1 {
    const rhs = Decimal4.from(other).scaled;
    return this.scaled < rhs ? -1 : this.scaled > rhs ? 1 : 0;
  }

  toString(): string {
    const negative = this.scaled < ZERO;
    const absolute = negative ? -this.scaled : this.scaled;
    const whole = absolute / SCALE;
    const fraction = String(absolute % SCALE).padStart(4, "0");
    return `${negative ? "-" : ""}${whole}.${fraction}`;
  }

  toJSON(): string {
    return this.toString();
  }
}

function divideRoundedHalfAwayFromZero(dividend: bigint, divisor: bigint): bigint {
  const negative = (dividend < ZERO) !== (divisor < ZERO);
  const absoluteDividend = dividend < ZERO ? -dividend : dividend;
  const absoluteDivisor = divisor < ZERO ? -divisor : divisor;
  const quotient = absoluteDividend / absoluteDivisor;
  const remainder = absoluteDividend % absoluteDivisor;
  const rounded = remainder * TWO >= absoluteDivisor ? quotient + BigInt(1) : quotient;
  return negative ? -rounded : rounded;
}

export function sumDecimal4(values: readonly (string | bigint | Decimal4)[]): Decimal4 {
  return values.reduce<Decimal4>((sum, value) => sum.add(value), Decimal4.zero());
}

export function assertCurrency(currency: string): string {
  const normalized = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error(`Invalid ISO-4217 currency code: ${currency}`);
  }
  return normalized;
}
