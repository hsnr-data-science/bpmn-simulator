export const defaultDiagram = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
  xmlns:sim="https://example.com/schema/bpmn-des-simulation"
  id="Definitions_DES_Demo"
  targetNamespace="https://example.com/bpmn-des-simulator">
  <bpmn:process id="Process_Order_Fulfillment" name="Order Fulfillment DES Demo" isExecutable="false">
    <bpmn:startEvent id="StartEvent_Order" name="Order received">
      <bpmn:extensionElements>
        <sim:SimulationParameters arrivalIntervalMean="1.5" />
      </bpmn:extensionElements>
      <bpmn:outgoing>Flow_Start_Check</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:userTask id="Task_Check_Order" name="Check order">
      <bpmn:extensionElements>
        <sim:SimulationParameters durationDistribution="triangular" durationMin="2" durationMode="4" durationMax="8" errorProbability="0.02" retryProbability="0.05" maxRetries="1" retryDelay="1" resourcePool="Clerks" resourceCapacity="2" />
      </bpmn:extensionElements>
      <bpmn:incoming>Flow_Start_Check</bpmn:incoming>
      <bpmn:outgoing>Flow_Check_Gateway</bpmn:outgoing>
    </bpmn:userTask>
    <bpmn:exclusiveGateway id="Gateway_Stock" name="In stock?">
      <bpmn:incoming>Flow_Check_Gateway</bpmn:incoming>
      <bpmn:outgoing>Flow_Stock_Yes</bpmn:outgoing>
      <bpmn:outgoing>Flow_Stock_No</bpmn:outgoing>
    </bpmn:exclusiveGateway>
    <bpmn:serviceTask id="Task_Pick_Pack" name="Pick and pack">
      <bpmn:extensionElements>
        <sim:SimulationParameters durationDistribution="normal" durationMean="6" durationStdDev="1.5" durationMin="1" errorProbability="0.03" retryProbability="0.04" maxRetries="2" retryDelay="2" resourcePool="Warehouse" resourceCapacity="3" outputKey="shipmentPriority" outputValues="standard,express" />
      </bpmn:extensionElements>
      <bpmn:incoming>Flow_Stock_Yes</bpmn:incoming>
      <bpmn:outgoing>Flow_Pack_Ship</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:manualTask id="Task_Backorder" name="Backorder item">
      <bpmn:extensionElements>
        <sim:SimulationParameters durationDistribution="uniform" durationMin="12" durationMax="36" resourcePool="Procurement" resourceCapacity="1" errorProbability="0.01" />
      </bpmn:extensionElements>
      <bpmn:incoming>Flow_Stock_No</bpmn:incoming>
      <bpmn:outgoing>Flow_Backorder_Ship</bpmn:outgoing>
    </bpmn:manualTask>
    <bpmn:serviceTask id="Task_Ship" name="Ship order">
      <bpmn:extensionElements>
        <sim:SimulationParameters durationDistribution="triangular" durationMin="3" durationMode="5" durationMax="12" errorProbability="0.02" retryProbability="0.03" maxRetries="1" retryDelay="2" resourcePool="Shipping" resourceCapacity="2" />
      </bpmn:extensionElements>
      <bpmn:incoming>Flow_Pack_Ship</bpmn:incoming>
      <bpmn:incoming>Flow_Backorder_Ship</bpmn:incoming>
      <bpmn:outgoing>Flow_Ship_End</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:endEvent id="EndEvent_Done" name="Order done">
      <bpmn:incoming>Flow_Ship_End</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_Start_Check" sourceRef="StartEvent_Order" targetRef="Task_Check_Order" />
    <bpmn:sequenceFlow id="Flow_Check_Gateway" sourceRef="Task_Check_Order" targetRef="Gateway_Stock" />
    <bpmn:sequenceFlow id="Flow_Stock_Yes" name="yes" sourceRef="Gateway_Stock" targetRef="Task_Pick_Pack">
      <bpmn:extensionElements>
        <sim:SimulationParameters probability="0.78" />
      </bpmn:extensionElements>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="Flow_Stock_No" name="no" sourceRef="Gateway_Stock" targetRef="Task_Backorder">
      <bpmn:extensionElements>
        <sim:SimulationParameters probability="0.22" />
      </bpmn:extensionElements>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="Flow_Pack_Ship" sourceRef="Task_Pick_Pack" targetRef="Task_Ship" />
    <bpmn:sequenceFlow id="Flow_Backorder_Ship" sourceRef="Task_Backorder" targetRef="Task_Ship" />
    <bpmn:sequenceFlow id="Flow_Ship_End" sourceRef="Task_Ship" targetRef="EndEvent_Done" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_DES_Demo">
    <bpmndi:BPMNPlane id="BPMNPlane_DES_Demo" bpmnElement="Process_Order_Fulfillment">
      <bpmndi:BPMNShape id="StartEvent_Order_di" bpmnElement="StartEvent_Order">
        <dc:Bounds x="160" y="170" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_Check_Order_di" bpmnElement="Task_Check_Order">
        <dc:Bounds x="250" y="148" width="120" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Gateway_Stock_di" bpmnElement="Gateway_Stock" isMarkerVisible="true">
        <dc:Bounds x="430" y="163" width="50" height="50" />
        <bpmndi:BPMNLabel>
          <dc:Bounds x="426" y="220" width="58" height="14" />
        </bpmndi:BPMNLabel>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_Pick_Pack_di" bpmnElement="Task_Pick_Pack">
        <dc:Bounds x="545" y="90" width="120" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_Backorder_di" bpmnElement="Task_Backorder">
        <dc:Bounds x="545" y="250" width="120" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_Ship_di" bpmnElement="Task_Ship">
        <dc:Bounds x="735" y="148" width="120" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="EndEvent_Done_di" bpmnElement="EndEvent_Done">
        <dc:Bounds x="920" y="170" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="Flow_Start_Check_di" bpmnElement="Flow_Start_Check">
        <di:waypoint x="196" y="188" />
        <di:waypoint x="250" y="188" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_Check_Gateway_di" bpmnElement="Flow_Check_Gateway">
        <di:waypoint x="370" y="188" />
        <di:waypoint x="430" y="188" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_Stock_Yes_di" bpmnElement="Flow_Stock_Yes">
        <di:waypoint x="455" y="163" />
        <di:waypoint x="455" y="130" />
        <di:waypoint x="545" y="130" />
        <bpmndi:BPMNLabel>
          <dc:Bounds x="484" y="112" width="18" height="14" />
        </bpmndi:BPMNLabel>
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_Stock_No_di" bpmnElement="Flow_Stock_No">
        <di:waypoint x="455" y="213" />
        <di:waypoint x="455" y="290" />
        <di:waypoint x="545" y="290" />
        <bpmndi:BPMNLabel>
          <dc:Bounds x="485" y="272" width="13" height="14" />
        </bpmndi:BPMNLabel>
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_Pack_Ship_di" bpmnElement="Flow_Pack_Ship">
        <di:waypoint x="665" y="130" />
        <di:waypoint x="700" y="130" />
        <di:waypoint x="700" y="188" />
        <di:waypoint x="735" y="188" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_Backorder_Ship_di" bpmnElement="Flow_Backorder_Ship">
        <di:waypoint x="665" y="290" />
        <di:waypoint x="700" y="290" />
        <di:waypoint x="700" y="188" />
        <di:waypoint x="735" y="188" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_Ship_End_di" bpmnElement="Flow_Ship_End">
        <di:waypoint x="855" y="188" />
        <di:waypoint x="920" y="188" />
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;
