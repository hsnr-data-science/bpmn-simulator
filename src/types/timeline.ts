export type TimelineEventType =
  | 'CASE_CREATED'
  | 'TOKEN_CREATED'
  | 'TOKEN_ENTER_ELEMENT'
  | 'TOKEN_LEAVE_ELEMENT'
  | 'TOKEN_MOVE_START'
  | 'TOKEN_MOVE_END'
  | 'TASK_STARTED'
  | 'TASK_COMPLETED'
  | 'GATEWAY_ENTERED'
  | 'GATEWAY_DECISION'
  | 'TOKEN_WAITING'
  | 'RESOURCE_ACQUIRED'
  | 'RESOURCE_RELEASED'
  | 'PROCESS_INSTANCE_COMPLETED'
  | 'PROCESS_INSTANCE_TERMINATED'
  | 'WARNING';

export interface SimulationEvent {
  id: string;
  simulationTime: number;
  sequence: number;
  type: TimelineEventType;
  processInstanceId: string;
  tokenId?: string;
  elementId?: string;
  sourceElementId?: string;
  targetElementId?: string;
  sequenceFlowId?: string;
  payload?: Record<string, unknown>;
}

export interface TimelineFrame {
  simulationTime: number;
  events: SimulationEvent[];
  sequenceStart: number;
  sequenceEnd: number;
}

export interface VisualState {
  simulationTime: number;
  tokens: VisualTokenState[];
  activeElements: string[];
  completedElements: string[];
  waitingTokens: VisualTokenState[];
  warnings: VisualWarning[];
}

export interface VisualTokenState {
  tokenId: string;
  processInstanceId: string;
  elementId?: string;
  sourceElementId?: string;
  targetElementId?: string;
  sequenceFlowId?: string;
  movement?: {
    sourceElementId: string;
    targetElementId: string;
    sequenceFlowId?: string;
    startTime: number;
    endTime: number;
    progress: number;
  };
  status:
    | 'created'
    | 'waiting'
    | 'active'
    | 'moving'
    | 'completed'
    | 'terminated';
}

export interface VisualWarning {
  id: string;
  simulationTime: number;
  elementId?: string;
  message: string;
}
