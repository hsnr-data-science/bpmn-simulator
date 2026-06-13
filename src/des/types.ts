export type DurationDistribution = 'constant' | 'uniform' | 'triangular' | 'normal' | 'exponential';

export type SimulationParameters = {
  enabled?: boolean;
  durationDistribution?: DurationDistribution;
  durationMin?: number;
  durationMode?: number;
  durationMean?: number;
  durationMax?: number;
  durationStdDev?: number;
  arrivalIntervalMean?: number;
  successProbability?: number;
  errorProbability?: number;
  retryProbability?: number;
  maxRetries?: number;
  retryDelay?: number;
  resourcePool?: string;
  resourceCapacity?: number;
  probability?: number;
  outputKey?: string;
  outputValues?: string[];
};

export type FlowNodeKind =
  | 'startEvent'
  | 'endEvent'
  | 'activity'
  | 'exclusiveGateway'
  | 'parallelGateway'
  | 'inclusiveGateway'
  | 'eventBasedGateway'
  | 'event'
  | 'unknown';

export type SimNode = {
  id: string;
  name: string;
  type: string;
  kind: FlowNodeKind;
  incoming: string[];
  outgoing: string[];
  params: Partial<SimulationParameters>;
};

export type SimFlow = {
  id: string;
  name: string;
  sourceId: string;
  targetId: string;
  params: Partial<SimulationParameters>;
};

export type SimModel = {
  id: string;
  name: string;
  nodes: Map<string, SimNode>;
  flows: Map<string, SimFlow>;
  startNodeIds: string[];
};

export type SimulationOptions = {
  cases: number;
  seed: number;
  untilTime?: number;
};

export type CaseStatus = 'completed' | 'failed' | 'running';

export type CaseResult = {
  id: number;
  startTime: number;
  endTime: number;
  cycleTime: number;
  status: CaseStatus;
  retries: number;
  path: string[];
  outputs: Record<string, string>;
};

export type ElementMetrics = {
  elementId: string;
  name: string;
  type: string;
  visits: number;
  completions: number;
  errors: number;
  retries: number;
  waitTime: number;
  serviceTime: number;
};

export type FlowMetrics = {
  flowId: string;
  name: string;
  count: number;
};

export type SimulationResult = {
  startedAt: Date;
  completedAt: Date;
  options: SimulationOptions;
  processName: string;
  cases: CaseResult[];
  completedCases: number;
  failedCases: number;
  cycleTimeAverage: number;
  cycleTimeP50: number;
  cycleTimeP90: number;
  cycleTimeMax: number;
  throughputPerTimeUnit: number;
  elementMetrics: ElementMetrics[];
  flowMetrics: FlowMetrics[];
  warnings: string[];
};

export type TokenPayload = {
  caseId: number;
  elementId: string;
  attempt: number;
};
