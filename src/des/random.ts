import type { SimulationParameters } from './types';

export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x6d2b79f5;
  }

  next(): number {
    this.state += 0x6d2b79f5;
    let value = this.state;

    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  pick<T>(values: T[]): T {
    return values[Math.min(values.length - 1, Math.floor(this.next() * values.length))];
  }
}

export function sampleDuration(params: Partial<SimulationParameters>, random: SeededRandom): number {
  const distribution = params.durationDistribution ?? inferDistribution(params);

  switch (distribution) {
    case 'constant':
      return nonNegative(params.durationMean ?? params.durationMode ?? params.durationMin ?? 1);
    case 'uniform':
      return uniform(params.durationMin ?? 0, params.durationMax ?? params.durationMean ?? 1, random);
    case 'triangular':
      return triangular(
        params.durationMin ?? 0,
        params.durationMode ?? params.durationMean ?? 1,
        params.durationMax ?? Math.max(params.durationMode ?? 1, params.durationMean ?? 1, 1),
        random
      );
    case 'normal':
      return clippedNormal(
        params.durationMean ?? params.durationMode ?? 1,
        params.durationStdDev ?? Math.max((params.durationMax ?? 1) - (params.durationMin ?? 0), 1) / 6,
        params.durationMin ?? 0,
        params.durationMax,
        random
      );
    case 'exponential':
      return exponential(params.durationMean ?? 1, random);
    default:
      return 1;
  }
}

export function bernoulli(probability: number | undefined, random: SeededRandom): boolean {
  return random.next() < clampProbability(probability ?? 0);
}

export function clampProbability(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function inferDistribution(params: Partial<SimulationParameters>) {
  if (params.durationMin !== undefined && params.durationMode !== undefined && params.durationMax !== undefined) {
    return 'triangular';
  }

  if (params.durationMin !== undefined && params.durationMax !== undefined) {
    return 'uniform';
  }

  return 'constant';
}

function uniform(min: number, max: number, random: SeededRandom): number {
  const low = Math.min(min, max);
  const high = Math.max(min, max);

  return nonNegative(low + random.next() * (high - low));
}

function triangular(min: number, mode: number, max: number, random: SeededRandom): number {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  const peak = Math.min(high, Math.max(low, mode));
  const u = random.next();
  const c = (peak - low) / Math.max(high - low, Number.EPSILON);

  if (u < c) {
    return nonNegative(low + Math.sqrt(u * (high - low) * (peak - low)));
  }

  return nonNegative(high - Math.sqrt((1 - u) * (high - low) * (high - peak)));
}

function clippedNormal(
  mean: number,
  stdDev: number,
  min: number,
  max: number | undefined,
  random: SeededRandom
): number {
  const u1 = Math.max(random.next(), Number.EPSILON);
  const u2 = random.next();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const sampled = mean + Math.abs(stdDev) * z;
  const clippedLow = Math.max(min, sampled);

  return nonNegative(max === undefined ? clippedLow : Math.min(max, clippedLow));
}

function exponential(mean: number, random: SeededRandom): number {
  const u = Math.max(random.next(), Number.EPSILON);

  return nonNegative(-Math.log(u) * Math.max(mean, Number.EPSILON));
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
