export type ParsedTimerExpression = {
  kind: 'duration' | 'cycle';
  durationMinutes: number;
  expression: string;
};

/**
 * Parses the duration portion of BPMN timer expressions. Calendar dates and
 * variable-length ISO units (months/years) are deliberately not simulated.
 */
export function parseTimerExpression(value: string | undefined): ParsedTimerExpression | undefined {
  const expression = value?.trim();

  if (!expression) {
    return undefined;
  }

  const cycle = /^R\d*\/(.+)$/i.exec(expression);
  const duration = cycle ? cycle[1] : expression;
  const durationMinutes = parseIsoDurationMinutes(duration);

  if (durationMinutes === undefined) {
    return undefined;
  }

  return {
    kind: cycle ? 'cycle' : 'duration',
    durationMinutes,
    expression
  };
}

export function parseIsoDurationMinutes(value: string): number | undefined {
  const match = /^P(?:(\d+(?:\.\d+)?)W|(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?)$/i.exec(value.trim());

  if (!match) {
    return undefined;
  }

  const [, weeks, days, hours, minutes, seconds] = match;

  if ([weeks, days, hours, minutes, seconds].every((part) => part === undefined)) {
    return undefined;
  }

  const toNumber = (part: string | undefined) => part === undefined ? 0 : Number(part);
  const total =
    toNumber(weeks) * 7 * 24 * 60 +
    toNumber(days) * 24 * 60 +
    toNumber(hours) * 60 +
    toNumber(minutes) +
    toNumber(seconds) / 60;

  return Number.isFinite(total) && total >= 0 ? total : undefined;
}
