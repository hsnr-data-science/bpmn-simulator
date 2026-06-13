import type { SimFlow, SimModel, SimNode } from '../types/bpmn';
import type { SimulationLogEntry } from '../types/simulation';
import { isTaskKind } from '../bpmn/BpmnElementClassifier';
import { SeededRandom } from './RandomDistributions';

type Logger = (entry: SimulationLogEntry) => void;

export type ConditionEvaluationContext = {
  caseId?: number;
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

  isTask(node: SimNode): boolean {
    return isTaskKind(node.kind);
  }

  isJoiningGateway(node: SimNode): boolean {
    return node.kind === 'parallelGateway' && node.incoming.length > 1;
  }

  isTimer(node: SimNode): boolean {
    return node.kind === 'timerIntermediateEvent';
  }

  isRootEndEvent(node: SimNode): boolean {
    return node.kind === 'endEvent' && !node.parentSubProcessId;
  }

  getSubProcessStarts(node: SimNode): string[] {
    return node.kind === 'subProcess' ? node.subProcessStartIds ?? [] : [];
  }

  getOutgoingFlowIds(
    node: SimNode,
    random: SeededRandom,
    log: Logger,
    context: ConditionEvaluationContext = {}
  ): string[] {
    if (node.kind === 'endEvent' && node.parentSubProcessId) {
      return this.model.nodes.get(node.parentSubProcessId)?.outgoing ?? [];
    }

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
      const matched = conditionalFlows.find((flow) => {
        return this.evaluateCondition(flow.conditionExpression, context);
      });

      if (!this.conditionWarnings.has(node.id)) {
        this.conditionWarnings.add(node.id);
        log({
          level: 'warning',
          message:
            `Gateway "${node.name}" besitzt bedingte Sequence Flows. ` +
            'Branch-Wahrscheinlichkeiten werden ignoriert; Condition-Evaluation ist vorbereitet und nutzt aktuell einen Stub.',
          elementId: node.id
        });
      }

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
    _conditionExpression: string | undefined,
    _context: ConditionEvaluationContext
  ): boolean {
    // Prepared extension point: later this will evaluate BPMN FormalExpression
    // bodies against case variables/outputs. For now the stub deliberately
    // returns false so Default Flow handling and warnings stay explicit.
    return false;
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
