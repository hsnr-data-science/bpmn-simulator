import type { DurationConfig, PossibleError, PossibleOutput } from '../types/simulation';

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
}

export function sampleDuration(config: DurationConfig | undefined, random: SeededRandom): number {
  const type = config?.type ?? inferDistribution(config);

  switch (type) {
    case 'fixed':
      return nonNegative(config?.mean ?? config?.mode ?? config?.min ?? 1);
    case 'uniform':
      return uniform(config?.min ?? 0, config?.max ?? config?.mean ?? 1, random);
    case 'triangular':
      return triangular(
        config?.min ?? 0,
        config?.mode ?? config?.mean ?? 1,
        config?.max ?? Math.max(config?.mode ?? 1, config?.mean ?? 1, 1),
        random
      );
    case 'normal':
      return clippedNormal(
        config?.mean ?? config?.mode ?? 1,
        config?.stddev ?? Math.max((config?.max ?? 1) - (config?.min ?? 0), 1) / 6,
        config?.min ?? 0,
        config?.max,
        random
      );
    case 'exponential':
      return exponential(config?.lambda ? 1 / config.lambda : config?.mean ?? 1, random);
    default:
      return 1;
  }
}

export function sampleInterarrival(mean: number, random: SeededRandom): number {
  return exponential(Math.max(mean, Number.EPSILON), random);
}

export function pickWeighted<T extends PossibleOutput | PossibleError>(
  entries: T[] | undefined,
  random: SeededRandom
): T | undefined {
  if (!entries?.length) {
    return undefined;
  }

  const weights = entries.map((entry) => clampProbability(entry.probability ?? 0));
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  if (total <= 0) {
    return entries[Math.floor(random.next() * entries.length)];
  }

  let needle = random.next() * total;

  for (let index = 0; index < entries.length; index += 1) {
    needle -= weights[index];

    if (needle <= 0) {
      return entries[index];
    }
  }

  return entries[entries.length - 1];
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

function inferDistribution(config: DurationConfig | undefined): DurationConfig['type'] {
  if (config?.min !== undefined && config.mode !== undefined && config.max !== undefined) {
    return 'triangular';
  }

  if (config?.min !== undefined && config.max !== undefined) {
    return 'uniform';
  }

  return 'fixed';
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
  stddev: number,
  min: number,
  max: number | undefined,
  random: SeededRandom
): number {
  const u1 = Math.max(random.next(), Number.EPSILON);
  const u2 = random.next();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const sampled = mean + Math.abs(stddev) * z;
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
