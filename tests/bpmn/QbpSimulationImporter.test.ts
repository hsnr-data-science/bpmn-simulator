import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBpmnGraph } from '../../src/bpmn/BpmnGraphBuilder';
import { readProcessConfig } from '../../src/bpmn/ExtensionElementReader';
import { importQbpSimulationInfo } from '../../src/bpmn/QbpSimulationImporter';
import simulationModdle from '../../src/bpmn/simulationModdle.json';
import type { BpmnDefinitions } from '../../src/types/bpmn';

type BpmnModdleInstance = {
  fromXML(xml: string): Promise<{ rootElement: BpmnDefinitions; warnings: unknown[] }>;
  toXML(rootElement: BpmnDefinitions, options?: Record<string, unknown>): Promise<{ xml: string }>;
};

type BpmnModdleCtor = new (extensions?: Record<string, unknown>) => BpmnModdleInstance;

test('QBP importer converts simulation data to DES extensions and removes QBP annotations', async () => {
  const sourceXml = readFileSync('tests/bpmn/InsuranceClaimsSimulationNormalSeason.bpmn', 'utf8');
  const imported = importQbpSimulationInfo(sourceXml);

  assert.equal(imported.imported, true);
  assert.equal(imported.startDateTime, '2014-03-02T09:01:54.000+00:00');
  assert.deepEqual(imported.summary, {
    processSimulationInfos: 1,
    resources: 3,
    taskConfigurations: 9,
    sequenceFlows: 10
  });
  assert.ok(imported.warnings.some((warning) => warning.includes('cost')));
  assert.equal(imported.warnings.filter((warning) => warning.includes('invalid BPMN association')).length, 2);
  assert.doesNotMatch(imported.xml, /qbp:/);
  assert.doesNotMatch(imported.xml, /xmlns:qbp/);
  assert.doesNotMatch(imported.xml, /sid-058952D8-EB49-492C-B9FE-DB79C2F3180C/);
  assert.doesNotMatch(imported.xml, /sid-A5736149-7537-47B7-AE07-6EFD6FA38A4E/);
  assert.match(imported.xml, /sim:processConfig/);
  assert.match(imported.xml, /sim:resourceCatalog/);
  assert.match(imported.xml, /sim:taskConfig/);
  assert.match(imported.xml, /sim:sequenceFlowConfig/);

  const { BpmnModdle } = await importBpmnModdle();
  const moddle = new BpmnModdle({ sim: simulationModdle });
  const { rootElement, warnings } = await moddle.fromXML(imported.xml);
  const model = buildBpmnGraph(rootElement);
  const process = rootElement.rootElements?.find((element) => element.$type === 'bpmn:Process');
  const start = model.nodes.get('sid-7303CAD1-2935-4E83-A338-9F6021051F2E');
  const firstTask = model.nodes.get('sid-EB82118C-91E4-4C06-A21D-8D9A13FD2A0E');
  const firstBranch = model.flows.get('sid-795F9EA0-EF4C-4730-95F8-673B271B4B63');

  assert.equal(readProcessConfig(process).startDateTime, imported.startDateTime);
  assert.deepEqual(model.resources.get('QBP_DEFAULT_RESOURCE'), {
    id: 'QBP_DEFAULT_RESOURCE',
    name: 'Call Centre Operator 1',
    capacity: 40,
    weekdays: [1, 2, 3, 4, 5],
    hourRanges: [{ start: 9, end: 17 }]
  });
  assert.equal(start?.params.arrival?.type, 'exponential');
  assert.ok(Math.abs((start?.params.arrival?.mean ?? 0) - (16 / 60)) < 1e-9);
  assert.equal(start?.params.arrival?.numberOfCases, 45000);
  assert.deepEqual(start?.params.arrival?.weekdays, [1, 2, 3, 4, 5]);
  assert.deepEqual(start?.params.arrival?.hourRanges, [{ start: 9, end: 17 }]);
  assert.equal(firstTask?.params.duration?.type, 'exponential');
  assert.equal(firstTask?.params.duration?.mean, 1);
  assert.equal(firstTask?.params.resource?.resourceId, 'QBP_DEFAULT_RESOURCE');
  assert.equal(firstBranch?.params.branch?.probability, 0.5);
  assert.equal(firstBranch?.hasCondition, false);
  assert.equal(
    warnings.some((warning) => String(warning).includes('Ref not specified')),
    false
  );

  const saved = await moddle.toXML(rootElement, { format: true });

  assert.doesNotMatch(saved.xml, /qbp:/);
  assert.doesNotMatch(saved.xml, /xmlns:qbp/);
  assert.match(saved.xml, /sim:arrival type="exponential"/);
  assert.match(saved.xml, /sim:duration type="exponential" mean="1"/);
});

test('QBP importer leaves ordinary BPMN XML unchanged', () => {
  const xml = '<?xml version="1.0"?><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"/>';
  const imported = importQbpSimulationInfo(xml);

  assert.equal(imported.imported, false);
  assert.equal(imported.xml, xml);
  assert.deepEqual(imported.warnings, []);
});

test('QBP importer sanitizes invalid BPMN associations even without QBP data', () => {
  const xml = `<?xml version="1.0"?>
    <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
      xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI">
      <process id="Process_1">
        <association id="broken" targetRef="note"/>
        <textAnnotation id="note"><text>Note</text></textAnnotation>
      </process>
      <bpmndi:BPMNDiagram id="diagram">
        <bpmndi:BPMNPlane id="plane" bpmnElement="Process_1">
          <bpmndi:BPMNEdge id="edge" bpmnElement="broken"/>
        </bpmndi:BPMNPlane>
      </bpmndi:BPMNDiagram>
    </definitions>`;
  const imported = importQbpSimulationInfo(xml);

  assert.equal(imported.imported, false);
  assert.doesNotMatch(imported.xml, /id="broken"/);
  assert.doesNotMatch(imported.xml, /bpmnElement="broken"/);
  assert.deepEqual(imported.warnings, [
    'Removed invalid BPMN association "broken" because sourceRef or targetRef was missing.'
  ]);
});

async function importBpmnModdle(): Promise<{ BpmnModdle: BpmnModdleCtor }> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as
    (specifier: string) => Promise<{ BpmnModdle: BpmnModdleCtor }>;

  return dynamicImport('bpmn-moddle');
}
