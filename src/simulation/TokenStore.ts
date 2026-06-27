import type { CaseOutputValue, CaseTrace, CaseTrigger, OutputValue, Token } from '../types/simulation';

export type CaseState = {
  id: number;
  processId?: string;
  trigger?: CaseTrigger;
  parentCaseId?: number;
  triggerElementId?: string;
  triggerEventKey?: string;
  startTime: number;
  endTime?: number;
  activeTokens: number;
  failed: boolean;
  retries: number;
  path: string[];
  outputs: Record<string, CaseOutputValue>;
  errors: string[];
  joinCounts: Map<string, number>;
};

export class TokenStore {
  private cases = new Map<number, CaseState>();
  private tokenSequence = 0;

  createCase(
    id: number,
    startTime: number,
    options: {
      processId?: string;
      trigger?: CaseTrigger;
      parentCaseId?: number;
      triggerElementId?: string;
      triggerEventKey?: string;
      outputs?: Record<string, CaseOutputValue>;
    } = {}
  ): CaseState {
    const state: CaseState = {
      id,
      processId: options.processId,
      trigger: options.trigger,
      parentCaseId: options.parentCaseId,
      triggerElementId: options.triggerElementId,
      triggerEventKey: options.triggerEventKey,
      startTime,
      activeTokens: 0,
      failed: false,
      retries: 0,
      path: [],
      outputs: cloneOutputs(options.outputs),
      errors: [],
      joinCounts: new Map()
    };

    this.cases.set(id, state);

    return state;
  }

  createToken(caseId: number, elementId: string, attempt = 0): Token {
    this.tokenSequence += 1;
    const state = this.getCase(caseId);

    return {
      id: `${caseId}:${this.tokenSequence}`,
      caseId,
      elementId,
      attempt,
      processId: state?.processId
    };
  }

  activate(token: Token): void {
    const state = this.getCase(token.caseId);

    if (state) {
      state.activeTokens += 1;
    }
  }

  consume(caseId: number, time: number, count = 1): void {
    const state = this.getCase(caseId);

    if (!state) {
      return;
    }

    state.activeTokens = Math.max(0, state.activeTokens - count);
    this.finishIfDone(state, time);
  }

  fail(caseId: number, errorCode: string | undefined, time: number): void {
    const state = this.getCase(caseId);

    if (!state) {
      return;
    }

    state.failed = true;

    if (errorCode) {
      state.errors.push(errorCode);
    }

    this.consume(caseId, time);
  }

  abort(caseId: number, errorCode: string | undefined, time: number): void {
    const state = this.getCase(caseId);

    if (!state || state.endTime !== undefined) {
      return;
    }

    state.failed = true;

    if (errorCode) {
      state.errors.push(errorCode);
    }

    state.activeTokens = 0;
    state.endTime = time;
  }

  terminate(caseId: number, time: number): void {
    const state = this.getCase(caseId);

    if (!state || state.endTime !== undefined) {
      return;
    }

    state.activeTokens = 0;
    state.endTime = time;
  }

  isOpen(caseId: number): boolean {
    return this.getCase(caseId)?.endTime === undefined;
  }

  recordPath(caseId: number, elementId: string, collectTraces: boolean): void {
    const state = this.getCase(caseId);

    if (state && collectTraces) {
      state.path.push(elementId);
    }
  }

  setOutput(caseId: number, key: string, value: CaseOutputValue): void {
    const state = this.getCase(caseId);

    if (state) {
      state.outputs[key] = value;
    }
  }

  setOutputObject(caseId: number, key: string, value: Record<string, OutputValue>): void {
    if (!Object.keys(value).length) {
      return;
    }

    this.setOutput(caseId, key, value);
  }

  mergeOutputs(caseId: number, outputs: Record<string, CaseOutputValue> | undefined): void {
    if (!outputs) {
      return;
    }

    const state = this.getCase(caseId);

    if (!state) {
      return;
    }

    state.outputs = {
      ...state.outputs,
      ...cloneOutputs(outputs)
    };
  }

  getCase(caseId: number): CaseState | undefined {
    return this.cases.get(caseId);
  }

  getCases(): CaseState[] {
    return [...this.cases.values()];
  }

  toTraces(currentTime: number): CaseTrace[] {
    return this.getCases().map((state) => {
      const endTime = state.endTime ?? currentTime;
      const status = state.endTime === undefined ? 'running' : state.failed ? 'failed' : 'completed';

      return {
        id: state.id,
        processId: state.processId,
        trigger: state.trigger,
        parentCaseId: state.parentCaseId,
        triggerElementId: state.triggerElementId,
        triggerEventKey: state.triggerEventKey,
        startTime: state.startTime,
        endTime,
        cycleTime: Math.max(0, endTime - state.startTime),
        status,
        retries: state.retries,
        activeTokens: state.activeTokens,
        path: state.path,
        outputs: state.outputs,
        errors: state.errors
      };
    });
  }

  private finishIfDone(state: CaseState, time: number): void {
    if (state.activeTokens === 0 && state.endTime === undefined) {
      state.endTime = time;
    }
  }
}

function cloneOutputs(
  outputs: Record<string, CaseOutputValue> | undefined
): Record<string, CaseOutputValue> {
  return outputs
    ? JSON.parse(JSON.stringify(outputs)) as Record<string, CaseOutputValue>
    : {};
}
