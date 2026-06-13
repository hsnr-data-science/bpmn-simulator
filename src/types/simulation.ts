export type DurationDistributionType = 'fixed' | 'uniform' | 'normal' | 'exponential' | 'triangular';

export type ArrivalDistributionType = 'fixedInterval' | 'exponentialInterarrival' | 'schedule';

export type RetryDelayDistributionType = DurationDistributionType;

export type OutputDistributionType = 'categorical' | 'none';

export type SimulationEventType =
  | 'CASE_ARRIVAL'
  | 'TOKEN_ENTER_ELEMENT'
  | 'TASK_START'
  | 'TASK_COMPLETE'
  | 'TIMER_FIRED'
  | 'MESSAGE_RECEIVED'
  | 'TOKEN_LEAVE_ELEMENT'
  | 'PROCESS_INSTANCE_COMPLETE'
  | 'TASK_FAILED'
  | 'RETRY_TASK';

export type DurationConfig = {
  type?: DurationDistributionType;
  mean?: number;
  stddev?: number;
  min?: number;
  max?: number;
  lambda?: number;
  mode?: number;
};

export type RetryDelayConfig = DurationConfig;

export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type HourRange = {
  start: number;
  end: number;
};

export type SimulationResource = {
  id: string;
  name: string;
  capacity?: number;
  calendar?: string;
  weekdays?: Weekday[];
  hourRanges?: HourRange[];
};

export type ResourceConfig = {
  resourceId?: string;
  resourceName?: string;
  capacity?: number;
  calendar?: string;
  weekdays?: Weekday[];
  hourRanges?: HourRange[];
};

export type FailureConfig = {
  probability?: number;
  retryCount?: number;
  retryDelay?: RetryDelayConfig;
};

export type PossibleOutput = {
  value: string;
  probability?: number;
};

export type OutputConfig = {
  distribution?: OutputDistributionType;
  possibleOutputs?: PossibleOutput[];
};

export type PossibleError = {
  errorCode: string;
  probability?: number;
};

export type ErrorConfig = {
  probability?: number;
  possibleErrors?: PossibleError[];
};

export type ArrivalConfig = {
  type?: ArrivalDistributionType;
  interval?: number;
  mean?: number;
  schedule?: string;
  numberOfCases?: number;
};

export type BranchConfig = {
  probability?: number;
};

export type TaskSimulationConfig = {
  enabled?: boolean;
  duration?: DurationConfig;
  resource?: ResourceConfig;
  failure?: FailureConfig;
  output?: OutputConfig;
  error?: ErrorConfig;
};

export type StartEventSimulationConfig = {
  enabled?: boolean;
  arrival?: ArrivalConfig;
};

export type SequenceFlowSimulationConfig = {
  enabled?: boolean;
  branch?: BranchConfig;
};

export type ElementSimulationConfig = TaskSimulationConfig &
  StartEventSimulationConfig &
  SequenceFlowSimulationConfig;

export type SimulationConfig = {
  numberOfRuns: number;
  maxSimulationTime?: number;
  randomSeed: number;
  animationSpeed: number;
  collectTraces: boolean;
};

export type SimulationEvent<TPayload = unknown> = {
  id: number;
  type: SimulationEventType;
  time: number;
  payload: TPayload;
};

export type Token = {
  id: string;
  caseId: number;
  elementId: string;
  attempt: number;
};

export type CaseStatus = 'completed' | 'failed' | 'running';

export type CaseTrace = {
  id: number;
  startTime: number;
  endTime: number;
  cycleTime: number;
  status: CaseStatus;
  retries: number;
  activeTokens: number;
  path: string[];
  outputs: Record<string, string>;
  errors: string[];
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
  unsupported: boolean;
};

export type FlowMetrics = {
  flowId: string;
  name: string;
  sourceId: string;
  targetId: string;
  count: number;
};

export type SimulationLogEntry = {
  level: 'info' | 'warning' | 'error';
  eventType?: SimulationEventType;
  caseId?: number;
  message: string;
  elementId?: string;
  elementName?: string;
  time?: number;
};

export type ActivityUtilization = {
  elementId: string;
  name: string;
  utilization: number;
  averageWaitTime: number;
  averageServiceTime: number;
  tokenCount: number;
};

export type PathProbability = {
  flowId: string;
  name: string;
  count: number;
  probability: number;
};

export type SimulationExports = {
  json: string;
  csv: string;
  xesLike: string;
};

export type SimulationResult = {
  startedAt: Date;
  completedAt: Date;
  options: SimulationConfig;
  processName: string;
  cases: CaseTrace[];
  completedCases: number;
  failedCases: number;
  cycleTimeAverage: number;
  cycleTimeP50: number;
  cycleTimeP90: number;
  cycleTimeMax: number;
  throughputPerTimeUnit: number;
  elementMetrics: ElementMetrics[];
  flowMetrics: FlowMetrics[];
  log: SimulationLogEntry[];
  warnings: string[];
  unsupportedElementIds: string[];
  activityUtilization: ActivityUtilization[];
  pathProbabilities: PathProbability[];
  deadlockSuspicions: number;
  unconsumedTokens: number;
  exports: SimulationExports;
};
