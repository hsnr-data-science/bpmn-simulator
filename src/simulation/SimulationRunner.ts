import type { SimModel } from '../types/bpmn';
import type { SimulationConfig, SimulationResult } from '../types/simulation';
import { DesEngine } from './DesEngine';

export class SimulationRunner {
  run(model: SimModel, config: SimulationConfig): SimulationResult {
    return new DesEngine(model, config).run();
  }
}
