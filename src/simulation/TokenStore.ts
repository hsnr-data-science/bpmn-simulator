import type { CaseTrace, Token } from '../types/simulation';

export type CaseState = {
  id: number;
  startTime: number;
  endTime?: number;
  activeTokens: number;
  failed: boolean;
  retries: number;
  path: string[];
  outputs: Record<string, string>;
  errors: string[];
  joinCounts: Map<string, number>;
};

export class TokenStore {
  private cases = new Map<number, CaseState>();
  private tokenSequence = 0;

  createCase(id: number, startTime: number): CaseState {
    const state: CaseState = {
      id,
      startTime,
      activeTokens: 0,
      failed: false,
      retries: 0,
      path: [],
      outputs: {},
      errors: [],
      joinCounts: new Map()
    };

    this.cases.set(id, state);

    return state;
  }

  createToken(caseId: number, elementId: string, attempt = 0): Token {
    this.tokenSequence += 1;

    return {
      id: `${caseId}:${this.tokenSequence}`,
      caseId,
      elementId,
      attempt
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

  incrementRetries(caseId: number): void {
    const state = this.getCase(caseId);

    if (state) {
      state.retries += 1;
    }
  }

  recordPath(caseId: number, elementId: string, collectTraces: boolean): void {
    const state = this.getCase(caseId);

    if (state && collectTraces) {
      state.path.push(elementId);
    }
  }

  setOutput(caseId: number, key: string, value: string): void {
    const state = this.getCase(caseId);

    if (state) {
      state.outputs[key] = value;
    }
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
