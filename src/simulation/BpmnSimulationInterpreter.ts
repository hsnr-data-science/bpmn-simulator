import type { SimEventDefinition, SimFlow, SimModel, SimNode } from '../types/bpmn';
import type { CaseOutputValue, SimulationLogEntry } from '../types/simulation';
import { isTaskKind } from '../bpmn/BpmnElementClassifier';
import { SeededRandom } from './RandomDistributions';

type Logger = (entry: SimulationLogEntry) => void;

export type ConditionEvaluationContext = {
  caseId?: number;
  outputs?: Record<string, CaseOutputValue>;
  variables?: Record<string, unknown>;
};

export class BpmnSimulationInterpreter {
  private readonly model: SimModel;
  private readonly conditionWarnings = new Set<string>();
  private readonly branchWarnings = new Set<string>();

  constructor(model: SimModel) {
    this.model = model;
  }

  getStartNode(): SimNode {
    const startNode = this.model.nodes.get(this.model.startNodeIds[0]);

    if (!startNode) {
      throw new Error('Start Event nicht gefunden.');
    }

    return startNode;
  }

  getRootStartNodes(): SimNode[] {
    return this.model.startNodeIds
      .map((startNodeId) => this.model.nodes.get(startNodeId))
      .filter(Boolean) as SimNode[];
  }

  isTask(node: SimNode): boolean {
    return isTaskKind(node.kind);
  }

  isJoiningGateway(node: SimNode): boolean {
    return node.kind === 'parallelGateway' && node.incoming.length > 1;
  }

  isEventBasedGateway(node: SimNode): boolean {
    return node.kind === 'eventBasedGateway';
  }

  isTimer(node: SimNode): boolean {
    return node.kind === 'timerIntermediateEvent';
  }

  isEventTriggeredStart(node: SimNode): boolean {
    return node.kind === 'startEvent' && this.hasEventDefinition(node, 'message', 'signal', 'timer');
  }

  isCatchingMessageOrSignalEvent(node: SimNode): boolean {
    return node.eventDirection === 'catch' &&
      node.kind !== 'startEvent' &&
      this.hasEventDefinition(node, 'message', 'signal');
  }

  isThrowingMessageOrSignalEvent(node: SimNode): boolean {
    return node.eventDirection === 'throw' && this.hasEventDefinition(node, 'message', 'signal');
  }

  getEventDefinitions(node: SimNode, ...types: SimEventDefinition['type'][]): SimEventDefinition[] {
    if (!types.length) {
      return node.eventDefinitions ?? [];
    }

    return (node.eventDefinitions ?? []).filter((definition) => types.includes(definition.type));
  }

  getEventKey(definition: SimEventDefinition): string {
    return definition.name ?? definition.refId ?? definition.id ?? definition.type;
  }

  isRootEndEvent(node: SimNode): boolean {
    return node.kind === 'endEvent' && !node.parentSubProcessId;
  }

  isTerminateEndEvent(node: SimNode): boolean {
    return node.kind === 'endEvent' && this.hasEventDefinition(node, 'terminate');
  }

  getSubProcessStarts(node: SimNode): string[] {
    return node.kind === 'subProcess' ? node.subProcessStartIds ?? [] : [];
  }

  getAttachedBoundaryEvents(activityId: string): SimNode[] {
    return [...this.model.nodes.values()].filter((node) => {
      return node.kind === 'boundaryEvent' && node.attachedToRefId === activityId;
    });
  }

  getOutgoingFlowIds(
    node: SimNode,
    random: SeededRandom,
    log: Logger,
    context: ConditionEvaluationContext = {}
  ): string[] {
    if (node.kind === 'parallelGateway') {
      return [...node.outgoing];
    }

    if (node.kind === 'exclusiveGateway') {
      return this.selectExclusiveGatewayFlow(node, random, log, context);
    }

    if (node.outgoing.length > 1) {
      log({
        level: 'warning',
        message: `Element "${node.name}" hat mehrere ausgehende Flows. Die DES-Engine waehlt stochastisch genau einen davon.`,
        elementId: node.id
      });

      return this.selectWeightedFlow(node, node.outgoing, random, log);
    }

    return [...node.outgoing];
  }

  getFlow(flowId: string): SimFlow | undefined {
    return this.model.flows.get(flowId);
  }

  getNode(nodeId: string): SimNode | undefined {
    return this.model.nodes.get(nodeId);
  }

  private hasEventDefinition(node: SimNode, ...types: SimEventDefinition['type'][]): boolean {
    return this.getEventDefinitions(node, ...types).length > 0;
  }

  private selectExclusiveGatewayFlow(
    node: SimNode,
    random: SeededRandom,
    log: Logger,
    context: ConditionEvaluationContext
  ): string[] {
    const outgoingFlows = node.outgoing
      .map((flowId) => this.model.flows.get(flowId))
      .filter(Boolean) as SimFlow[];
    const conditionalFlows = outgoingFlows.filter((flow) => flow.hasCondition);

    if (conditionalFlows.length) {
      if (!this.conditionWarnings.has(node.id)) {
        this.conditionWarnings.add(node.id);
        log({
          level: 'warning',
          message:
            `Gateway "${node.name}" besitzt bedingte Sequence Flows. ` +
            'Branch-Wahrscheinlichkeiten werden ignoriert; Conditions werden als JavaScript-Ausdruecke ausgewertet.',
          elementId: node.id
        });
      }

      const matched = conditionalFlows.find((flow) => {
        return this.evaluateCondition(flow.conditionExpression, context, (message) => {
          this.warnOnce(node.id, `condition-error-${flow.id}`, log, {
            level: 'warning',
            message: `Condition auf Flow "${flow.name}" konnte nicht ausgewertet werden: ${message}`,
            elementId: flow.id
          });
        });
      });

      if (matched) {
        return [matched.id];
      }

      if (node.defaultFlowId && this.model.flows.has(node.defaultFlowId)) {
        return [node.defaultFlowId];
      }

      this.warnOnce(node.id, 'condition-no-default', log, {
        level: 'warning',
        message: `Gateway "${node.name}" hat Bedingungen, aber keine Bedingung ist wahr und kein Default Flow ist gesetzt.`,
        elementId: node.id
      });

      return [];
    }

    if (outgoingFlows.length <= 1) {
      return outgoingFlows.map((flow) => flow.id);
    }

    return this.selectWeightedFlow(node, node.outgoing, random, log);
  }

  private selectWeightedFlow(node: SimNode, flowIds: string[], random: SeededRandom, log: Logger): string[] {
    if (!flowIds.length) {
      return [];
    }

    const probabilities = flowIds.map((flowId) => this.model.flows.get(flowId)?.params.branch?.probability);
    const missingProbability = probabilities.some((probability) => probability === undefined);

    if (missingProbability) {
      this.warnOnce(node.id, 'branch-missing', log, {
        level: 'warning',
        message: `Gateway "${node.name}" nutzt gleichverteilte Branch-Auswahl, weil mindestens eine branchProbability fehlt.`,
        elementId: node.id
      });

      return [flowIds[Math.floor(random.next() * flowIds.length)]];
    }

    const weights = probabilities.map((probability) => Math.max(0, probability ?? 0));
    const total = weights.reduce((sum, weight) => sum + weight, 0);

    if (total <= 0) {
      this.warnOnce(node.id, 'branch-zero', log, {
        level: 'warning',
        message: `Gateway "${node.name}" hat Branch-Wahrscheinlichkeiten mit Summe 0. Es wird gleichverteilt gewaehlt.`,
        elementId: node.id
      });

      return [flowIds[Math.floor(random.next() * flowIds.length)]];
    }

    if (Math.abs(total - 1) > 0.000001) {
      this.warnOnce(node.id, 'branch-normalized', log, {
        level: 'warning',
        message: `Gateway "${node.name}" hat Branch-Wahrscheinlichkeiten mit Summe ${formatProbability(total)}. Sie werden normalisiert.`,
        elementId: node.id
      });
    }

    let needle = random.next() * total;

    for (let index = 0; index < flowIds.length; index += 1) {
      needle -= weights[index];

      if (needle <= 0) {
        return [flowIds[index]];
      }
    }

    return [flowIds[flowIds.length - 1]];
  }

  evaluateCondition(
    conditionExpression: string | undefined,
    context: ConditionEvaluationContext = {},
    onError?: (message: string) => void
  ): boolean {
    const expression = normalizeConditionExpression(conditionExpression);

    if (!expression) {
      return false;
    }

    const variables = createConditionVariables(context);
    const outputs = context.outputs ?? {};

    try {
      const evaluator = new Function(
        'variables',
        'outputs',
        'caseId',
        `
          const processVariables = variables;
          const outputObjects = outputs;
          const currentCaseId = caseId;
          with (variables) {
            ${createEvaluationBody(expression)}
          }
        `
      );

      return Boolean(evaluator(variables, outputs, context.caseId));
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  private warnOnce(nodeId: string, key: string, log: Logger, entry: SimulationLogEntry): void {
    const warningKey = `${nodeId}:${key}`;

    if (this.branchWarnings.has(warningKey)) {
      return;
    }

    this.branchWarnings.add(warningKey);
    log(entry);
  }
}

function formatProbability(value: number): string {
  return Math.round(value * 1000) / 1000 + '';
}

function normalizeConditionExpression(conditionExpression: string | undefined): string | undefined {
  const expression = conditionExpression?.trim();

  if (!expression) {
    return undefined;
  }

  if (expression.startsWith('${') && expression.endsWith('}')) {
    return stripTrailingSemicolons(expression.slice(2, -1).trim());
  }

  return stripTrailingSemicolons(expression);
}

function stripTrailingSemicolons(expression: string): string {
  return expression.replace(/;+\s*$/, '').trim();
}

function createEvaluationBody(expression: string): string {
  if (/^\s*return\b/.test(expression) || expression.includes(';')) {
    return expression;
  }

  return `return (${expression});`;
}

function createConditionVariables(context: ConditionEvaluationContext): Record<string, unknown> {
  const variables: Record<string, unknown> = {
    ...(context.variables ?? {})
  };

  for (const [elementId, value] of Object.entries(context.outputs ?? {})) {
    variables[elementId] = value;

    if (isRecord(value)) {
      Object.assign(variables, value);
    }
  }

  return variables;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
