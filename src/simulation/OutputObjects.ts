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

export function parseOutputObjectText(value: string | undefined): OutputFieldConfig[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const fields = value
    .split(/[\n;]/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseOutputFieldText)
    .filter((field): field is OutputFieldConfig => Boolean(field));

  return fields.length ? fields : undefined;
}

export function serializeOutputObjectFields(fields: OutputFieldConfig[] | undefined): string {
  return (fields ?? []).map(serializeOutputField).join('; ');
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

function parseOutputFieldText(value: string): OutputFieldConfig | undefined {
  const [key, rawType, rawGenerator, ...rawParamParts] = value.split(':').map((part) => part.trim());
  const rawParams = rawParamParts.join(':');

  if (!key || !rawType) {
    return undefined;
  }

  const type = normalizeOutputType(rawType);

  if (!type) {
    return undefined;
  }

  const generator = normalizeGenerator(type, rawGenerator);
  const params = parseParams(rawParams);
  const field: OutputFieldConfig = {
    key,
    type,
    generator
  };

  if (generator === 'categorical' || generator === 'randomChoice') {
    field.choices = parseOutputChoices(rawParams);
  } else {
    Object.assign(field, params);
  }

  if (params.value !== undefined && generator !== 'categorical' && generator !== 'randomChoice') {
    field.value = String(params.value);
  }

  return field;
}

function parseParams(value: string | undefined): Record<string, string | number> {
  if (!value?.trim()) {
    return {};
  }

  if (!value.includes('=')) {
    return {
      value
    };
  }

  return Object.fromEntries(
    value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [key, rawValue] = part.split('=').map((segment) => segment.trim());
        const number = parseOptionalNumber(rawValue);

        return [key, number ?? rawValue ?? ''];
      })
  );
}

function serializeOutputField(field: OutputFieldConfig): string {
  const generator = field.generator ?? defaultGenerator(field.type);

  if (generator === 'categorical' || generator === 'randomChoice') {
    return `${field.key}:${field.type}:${generator}:${serializeOutputChoices(field.choices) ?? ''}`;
  }

  if (generator === 'fixed') {
    return `${field.key}:${field.type}:fixed:${field.value ?? field.mean ?? ''}`;
  }

  if (generator === 'random') {
    return `${field.key}:string:random:length=${field.length ?? 8}`;
  }

  return `${field.key}:${field.type}:${generator}:${serializeDistributionParams(field)}`;
}

function serializeDistributionParams(field: OutputFieldConfig): string {
  return [
    ['mean', field.mean],
    ['stddev', field.stddev],
    ['min', field.min],
    ['max', field.max],
    ['mode', field.mode],
    ['lambda', field.lambda]
  ]
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
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

function normalizeOutputType(value: string): OutputFieldConfig['type'] | undefined {
  const normalized = value.toLowerCase();

  if (normalized === 'int' || normalized === 'integer') {
    return 'int';
  }

  if (normalized === 'float' || normalized === 'double' || normalized === 'number') {
    return 'float';
  }

  if (normalized === 'string' || normalized === 'str') {
    return 'string';
  }

  return undefined;
}

function normalizeGenerator(
  type: OutputFieldConfig['type'],
  value: string | undefined
): OutputFieldConfig['generator'] {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) {
    return defaultGenerator(type);
  }

  if (normalized === 'choice') {
    return type === 'string' ? 'categorical' : 'randomChoice';
  }

  if (normalized === 'randomchoice') {
    return 'randomChoice';
  }

  if (normalized === 'randomstring') {
    return 'random';
  }

  if (['fixed', 'randomChoice', 'uniform', 'normal', 'exponential', 'triangular', 'random', 'categorical'].includes(normalized)) {
    return normalized as OutputFieldConfig['generator'];
  }

  return defaultGenerator(type);
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
