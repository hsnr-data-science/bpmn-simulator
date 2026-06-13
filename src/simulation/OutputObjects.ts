import type {
  DurationConfig,
  OutputChoice,
  OutputFieldConfig,
  OutputObjectConfig,
  OutputValue
} from '../types/simulation';
import { pickWeighted, sampleDuration, SeededRandom } from './RandomDistributions';

const STRING_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function sampleOutputObject(
  config: OutputObjectConfig | undefined,
  random: SeededRandom
): Record<string, OutputValue> {
  const output: Record<string, OutputValue> = {};

  for (const field of config?.fields ?? []) {
    const key = field.key.trim();

    if (!key) {
      continue;
    }

    output[key] = sampleOutputField(field, random);
  }

  return output;
}

export function sampleOutputField(field: OutputFieldConfig, random: SeededRandom): OutputValue {
  if (field.type === 'string') {
    return sampleStringField(field, random);
  }

  const sampled = sampleNumericField(field, random);

  return field.type === 'int' ? Math.round(sampled) : sampled;
}

export function parseOutputChoices(value: string | undefined): OutputChoice[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const choices = value
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [rawValue, rawProbability] = part.split(':').map((segment) => segment.trim());

      return {
        value: rawValue,
        probability: parseOptionalNumber(rawProbability)
      };
    })
    .filter((choice) => choice.value);

  return choices.length ? choices : undefined;
}

export function serializeOutputChoices(choices: OutputChoice[] | undefined): string | undefined {
  if (!choices?.length) {
    return undefined;
  }

  return choices
    .map((choice) => choice.probability === undefined ? choice.value : `${choice.value}:${choice.probability}`)
    .join('|');
}

function sampleStringField(field: OutputFieldConfig, random: SeededRandom): string {
  const generator = field.generator ?? defaultGenerator(field.type);

  if (generator === 'categorical') {
    return pickWeighted(field.choices, random)?.value ?? '';
  }

  if (generator === 'fixed') {
    return field.value ?? '';
  }

  const length = Math.max(1, Math.min(64, Math.floor(field.length ?? field.mean ?? 8)));
  let value = '';

  for (let index = 0; index < length; index += 1) {
    value += STRING_ALPHABET[Math.floor(random.next() * STRING_ALPHABET.length)];
  }

  return value;
}

function sampleNumericField(field: OutputFieldConfig, random: SeededRandom): number {
  const generator = field.generator ?? defaultGenerator(field.type);

  if (generator === 'randomChoice') {
    return Number(pickWeighted(field.choices, random)?.value ?? 0);
  }

  if (generator === 'fixed') {
    return Number(field.value ?? field.mean ?? field.min ?? 0);
  }

  return sampleDuration({
    type: generator as DurationConfig['type'],
    mean: field.mean,
    stddev: field.stddev,
    min: field.min,
    max: field.max,
    mode: field.mode,
    lambda: field.lambda
  }, random);
}

function defaultGenerator(type: OutputFieldConfig['type']): OutputFieldConfig['generator'] {
  return type === 'string' ? 'random' : 'fixed';
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : undefined;
}
