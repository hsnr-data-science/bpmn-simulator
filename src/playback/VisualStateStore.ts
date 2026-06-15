import type { SimulationEvent, TimelineFrame, VisualState, VisualTokenState, VisualWarning } from '../types/timeline';

export class VisualStateStore {
  private readonly frames: TimelineFrame[];
  private state: MutableVisualState = createEmptyState(0);
  private appliedFrameIndex = -1;

  constructor(frames: TimelineFrame[] = []) {
    this.frames = frames;
  }

  rebuildUntil(time: number): VisualState {
    if (time < this.state.simulationTime) {
      this.state = createEmptyState(time);
      this.appliedFrameIndex = -1;
    }

    while (this.appliedFrameIndex + 1 < this.frames.length) {
      const nextFrame = this.frames[this.appliedFrameIndex + 1];

      if (nextFrame.simulationTime > time) {
        break;
      }

      this.applyFrame(nextFrame);
      this.appliedFrameIndex += 1;
    }

    this.state.simulationTime = time;
    this.updateMovementProgress(time);

    return this.getState();
  }

  applyFrame(frame: TimelineFrame): void {
    this.state.simulationTime = frame.simulationTime;

    for (const event of frame.events) {
      this.applyEvent(event);
    }
  }

  getState(): VisualState {
    const tokens = [...this.state.tokens.values()]
      .filter((token) => token.status !== 'terminated')
      .map((token) => ({ ...token, movement: token.movement ? { ...token.movement } : undefined }));

    return {
      simulationTime: this.state.simulationTime,
      tokens,
      activeElements: [...this.state.activeElements],
      completedElements: [...this.state.completedElements],
      waitingTokens: tokens.filter((token) => token.status === 'waiting'),
      warnings: this.state.warnings.map((warning) => ({ ...warning }))
    };
  }

  private applyEvent(event: SimulationEvent): void {
    if (event.type === 'WARNING') {
      this.state.warnings.push({
        id: event.id,
        simulationTime: event.simulationTime,
        elementId: event.elementId,
        message: String(event.payload?.message ?? 'Warning')
      });
      return;
    }

    const token = event.tokenId ? this.ensureToken(event) : undefined;

    switch (event.type) {
      case 'TOKEN_CREATED':
        if (token) {
          token.status = 'created';
        }
        break;
      case 'TOKEN_ENTER_ELEMENT':
      case 'GATEWAY_ENTERED':
        if (token && event.elementId) {
          setTokenAtElement(token, event.elementId, 'active');
        }
        break;
      case 'TOKEN_WAITING':
        if (token && event.elementId) {
          setTokenAtElement(token, event.elementId, 'waiting');
        }
        break;
      case 'TOKEN_LEAVE_ELEMENT':
        if (token) {
          token.status = 'terminated';
          token.elementId = undefined;
        }
        break;
      case 'TOKEN_MOVE_START':
        if (token && event.sourceElementId && event.targetElementId) {
          token.status = 'moving';
          token.elementId = undefined;
          token.sourceElementId = event.sourceElementId;
          token.targetElementId = event.targetElementId;
          token.sequenceFlowId = event.sequenceFlowId;
          token.movement = {
            sourceElementId: event.sourceElementId,
            targetElementId: event.targetElementId,
            sequenceFlowId: event.sequenceFlowId,
            startTime: event.simulationTime,
            endTime: Number(event.payload?.endTime ?? event.simulationTime),
            progress: 0
          };
        }
        break;
      case 'TOKEN_MOVE_END':
        if (token && event.payload?.terminateOnEnd) {
          token.status = 'terminated';
          token.elementId = undefined;
          token.sourceElementId = undefined;
          token.targetElementId = undefined;
          token.sequenceFlowId = undefined;
          token.movement = undefined;
        } else if (token && (event.targetElementId || event.elementId)) {
          setTokenAtElement(token, event.targetElementId ?? event.elementId ?? '', 'active');
        }
        break;
      case 'TASK_STARTED':
        if (event.elementId) {
          this.state.activeElements.add(event.elementId);
        }

        if (token && event.elementId) {
          setTokenAtElement(token, event.elementId, 'active');
        }
        break;
      case 'TASK_COMPLETED':
        if (event.elementId) {
          this.state.activeElements.delete(event.elementId);
          this.state.completedElements.add(event.elementId);
        }
        break;
      case 'RESOURCE_ACQUIRED':
      case 'RESOURCE_RELEASED':
      case 'GATEWAY_DECISION':
      case 'CASE_CREATED':
        break;
      case 'PROCESS_INSTANCE_COMPLETED':
        if (token) {
          token.status = 'completed';
        }
        break;
    }
  }

  private ensureToken(event: SimulationEvent): VisualTokenState {
    const tokenId = event.tokenId ?? `${event.processInstanceId}:${event.sequence}`;
    const existing = this.state.tokens.get(tokenId);

    if (existing) {
      return existing;
    }

    const token: VisualTokenState = {
      tokenId,
      processInstanceId: event.processInstanceId,
      elementId: event.elementId,
      status: 'created'
    };

    this.state.tokens.set(tokenId, token);

    return token;
  }

  private updateMovementProgress(time: number): void {
    for (const token of this.state.tokens.values()) {
      if (token.status !== 'moving' || !token.movement) {
        continue;
      }

      const duration = token.movement.endTime - token.movement.startTime;
      const progress = duration <= 0
        ? 1
        : Math.max(0, Math.min(1, (time - token.movement.startTime) / duration));

      token.movement.progress = progress;
    }
  }
}

type MutableVisualState = {
  simulationTime: number;
  tokens: Map<string, VisualTokenState>;
  activeElements: Set<string>;
  completedElements: Set<string>;
  warnings: VisualWarning[];
};

function createEmptyState(simulationTime: number): MutableVisualState {
  return {
    simulationTime,
    tokens: new Map(),
    activeElements: new Set(),
    completedElements: new Set(),
    warnings: []
  };
}

function setTokenAtElement(
  token: VisualTokenState,
  elementId: string,
  status: VisualTokenState['status']
): void {
  token.status = status;
  token.elementId = elementId;
  token.sourceElementId = undefined;
  token.targetElementId = undefined;
  token.sequenceFlowId = undefined;
  token.movement = undefined;
}
