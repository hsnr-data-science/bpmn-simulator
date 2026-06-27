import insuranceClaimsDiagram from '../../tests/bpmn/InsuranceClaimsSimulationNormalSeason.bpmn?raw';
import messagingDiagram from '../../tests/bpmn/messaging.bpmn?raw';
import pizzaDeliveryDiagram from '../../tests/bpmn/pizza-delivery.bpmn?raw';
import subProcessDiagram from '../../tests/bpmn/order-fulfillment-with-subprocess.bpmn?raw';
import simpleOrderDiagram from '../../tests/bpmn/simple-order-fullfillment-des-demo.bpmn?raw';

export type DemoModel = {
  id: string;
  name: string;
  xml: string;
};

export const DEMO_MODELS: DemoModel[] = [
  {
    id: 'simple-order',
    name: 'Simple Order Fulfillment',
    xml: simpleOrderDiagram
  },
  {
    id: 'messaging',
    name: 'Messaging and Signals',
    xml: messagingDiagram
  },
  {
    id: 'subprocess-errors',
    name: 'Order Fulfillment with Subprocess Errors',
    xml: subProcessDiagram
  },
  {
    id: 'pizza-delivery',
    name: 'Pizza Delivery with Timer Events',
    xml: pizzaDeliveryDiagram
  },
  {
    id: 'insurance-claims',
    name: 'Insurance Claims (QBP Import)',
    xml: insuranceClaimsDiagram
  }
];

export function getDemoModel(id: string | undefined): DemoModel {
  return DEMO_MODELS.find((model) => model.id === id) ?? DEMO_MODELS[0];
}
