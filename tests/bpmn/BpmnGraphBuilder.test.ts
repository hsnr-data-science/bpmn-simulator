import test from 'node:test';
import assert from 'node:assert/strict';
import type { BpmnDefinitions } from '../../src/types/bpmn';
import { buildBpmnGraph } from '../../src/bpmn/BpmnGraphBuilder';

test('BpmnGraphBuilder resolves task resource references from the global resource catalog', () => {
  const definitions: BpmnDefinitions = {
    rootElements: [
      {
        $type: 'bpmn:Process',
        id: 'process',
        extensionElements: {
          values: [
            {
              $type: 'sim:ResourceCatalog',
              resources: [
                {
                  $type: 'sim:Resource',
                  id: 'clerk',
                  name: 'Clerk Team',
                  capacity: '2',
                  weekdays: '1,2,3,4,5',
                  hourRanges: '8-17'
                }
              ]
            }
          ]
        },
        flowElements: [
          {
            $type: 'bpmn:StartEvent',
            id: 'start',
            outgoing: [{ id: 'flow_start_task' }]
          },
          {
            $type: 'bpmn:Task',
            id: 'task',
            incoming: [{ id: 'flow_start_task' }],
            outgoing: [{ id: 'flow_task_end' }],
            extensionElements: {
              values: [
                {
                  $type: 'sim:TaskConfig',
                  resource: {
                    $type: 'sim:Resource',
                    id: 'clerk'
                  }
                }
              ]
            }
          },
          {
            $type: 'bpmn:EndEvent',
            id: 'end',
            incoming: [{ id: 'flow_task_end' }]
          },
          {
            $type: 'bpmn:SequenceFlow',
            id: 'flow_start_task',
            sourceRef: { id: 'start' },
            targetRef: { id: 'task' }
          },
          {
            $type: 'bpmn:SequenceFlow',
            id: 'flow_task_end',
            sourceRef: { id: 'task' },
            targetRef: { id: 'end' }
          }
        ]
      }
    ]
  };

  const model = buildBpmnGraph(definitions);
  const task = model.nodes.get('task');

  assert.equal(model.resources.get('clerk')?.name, 'Clerk Team');
  assert.equal(task?.params.resource?.resourceName, 'Clerk Team');
  assert.equal(task?.params.resource?.capacity, 2);
  assert.deepEqual(task?.params.resource?.weekdays, [1, 2, 3, 4, 5]);
  assert.deepEqual(task?.params.resource?.hourRanges, [{ start: 8, end: 17 }]);
});
