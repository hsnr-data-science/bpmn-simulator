import test from 'node:test';
import assert from 'node:assert/strict';
import {
  eventLogDatasetFromImportPreview,
  parseEventLogText,
  prepareEventLogImport
} from '../../src/simulation/EventLogDataset';

test('parseEventLogText imports semicolon-separated Event Log CSV exports', () => {
  const csv = [
    'CaseID;TaskID / EventID;TaskName / Event Name;Startzeit;Endzeit;Resource;Variables',
    '1;Task_A;Check Order;2026-06-15 08:00:00;2026-06-15 08:10:00;Alice;"{""score"":2}"',
    '1;Task_B;Approve Order;2026-06-15 08:12:00;2026-06-15 08:15:00;Bob;"{""approved"":true}"'
  ].join('\n');

  const dataset = parseEventLogText(csv, 'event-log.csv');

  assert.equal(dataset.records.length, 2);
  assert.equal(dataset.records[0].caseId, '1');
  assert.equal(dataset.records[0].activityName, 'Check Order');
  assert.equal(dataset.records[0].resource, 'Alice');
  assert.deepEqual(dataset.records[0].variables, { score: 2 });
  assert.equal(dataset.warnings.length, 0);
});

test('parseEventLogText imports JSON event log records with common process mining keys', () => {
  const dataset = parseEventLogText(JSON.stringify([
    {
      'case:concept:name': 'PI-1',
      'concept:name': 'Start',
      'time:timestamp': '2026-06-15T08:00:00',
      'org:resource': 'Alice'
    }
  ]));

  assert.equal(dataset.records.length, 1);
  assert.equal(dataset.records[0].caseId, 'PI-1');
  assert.equal(dataset.records[0].activityName, 'Start');
  assert.equal(dataset.records[0].resource, 'Alice');
  assert.equal(dataset.records[0].endTime?.getTime(), dataset.records[0].startTime.getTime() + 60_000);
});

test('prepareEventLogImport creates a mapping preview for custom CSV columns', () => {
  const csv = [
    'Instance;Step;Begin;Finish;Worker',
    'C-1;Register;2026-06-15T08:00:00;2026-06-15T08:05:00;Alice'
  ].join('\n');
  const preparation = prepareEventLogImport(csv, 'custom.csv');

  assert.equal(preparation.kind, 'mapped');

  if (preparation.kind !== 'mapped') {
    return;
  }

  const dataset = eventLogDatasetFromImportPreview(preparation.preview, {
    caseId: 'Instance',
    activityName: 'Step',
    startTime: 'Begin',
    endTime: 'Finish',
    resource: 'Worker'
  });

  assert.equal(dataset.records.length, 1);
  assert.equal(dataset.records[0].caseId, 'C-1');
  assert.equal(dataset.records[0].activityName, 'Register');
  assert.equal(dataset.records[0].resource, 'Alice');
});

test('event-log mapper parses compact timestamps from process-mining CSV logs', () => {
  const csv = [
    'case_id;activity;timestamp',
    '1;a;20210101T0001',
    '1;b;20210101T0002'
  ].join('\n');
  const preparation = prepareEventLogImport(csv, 'simple.csv');

  assert.equal(preparation.kind, 'mapped');

  if (preparation.kind !== 'mapped') {
    return;
  }

  const dataset = eventLogDatasetFromImportPreview(
    preparation.preview,
    preparation.preview.suggestedMapping,
    {
      timestampFormat: 'yyyyMMddTHHmm',
      instantRecordHandling: 'event'
    }
  );

  assert.equal(dataset.records.length, 2);
  assert.equal(dataset.records[0].startTime.getFullYear(), 2021);
  assert.equal(dataset.records[0].startTime.getMonth(), 0);
  assert.equal(dataset.records[0].startTime.getDate(), 1);
  assert.equal(dataset.records[0].startTime.getHours(), 0);
  assert.equal(dataset.records[0].startTime.getMinutes(), 1);
  assert.equal(dataset.records[0].endTime, undefined);
});

test('event-log mapper can import missing end times as nominal activities', () => {
  const csv = [
    'case_id;activity;timestamp',
    '1;a;20210101T0001'
  ].join('\n');
  const preparation = prepareEventLogImport(csv, 'activity.csv');

  assert.equal(preparation.kind, 'mapped');

  if (preparation.kind !== 'mapped') {
    return;
  }

  const dataset = eventLogDatasetFromImportPreview(
    preparation.preview,
    preparation.preview.suggestedMapping,
    {
      timestampFormat: 'yyyyMMddTHHmm',
      instantRecordHandling: 'activity'
    }
  );

  assert.equal(dataset.records.length, 1);
  assert.equal(
    dataset.records[0].endTime?.getTime(),
    dataset.records[0].startTime.getTime() + 60_000
  );
});

test('event-log mapper pairs lifecycle start and complete rows into activity durations', () => {
  const csv = [
    'activity;lifecycle:transition;timestamp;case_id',
    'Start;start;2011-06-18 07:33:29+02:00;41',
    'Start;complete;2011-06-18 07:33:29+02:00;41',
    'dress;start;2011-06-18 07:33:29+02:00;41',
    'dress;complete;2011-06-18 07:34:59+02:00;41'
  ].join('\n');
  const preparation = prepareEventLogImport(csv, 'weekends-sample.csv');

  assert.equal(preparation.kind, 'mapped');

  if (preparation.kind !== 'mapped') {
    return;
  }

  assert.equal(preparation.preview.suggestedMapping.lifecycleTransition, 'lifecycle:transition');

  const dataset = eventLogDatasetFromImportPreview(preparation.preview, preparation.preview.suggestedMapping);

  assert.equal(dataset.records.length, 2);
  assert.equal(dataset.records[0].activityName, 'Start');
  assert.equal(
    dataset.records[0].endTime?.getTime(),
    dataset.records[0].startTime.getTime() + 60_000
  );
  assert.equal(dataset.records[1].activityName, 'dress');
  assert.equal(
    dataset.records[1].endTime?.getTime(),
    dataset.records[1].startTime.getTime() + 90_000
  );
});

test('parseEventLogText imports XES lifecycle start and complete events as durations', () => {
  const xes = `
    <log>
      <trace>
        <string key="concept:name" value="Case-1" />
        <event>
          <string key="concept:name" value="Check" />
          <string key="lifecycle:transition" value="start" />
          <string key="org:resource" value="Alice" />
          <date key="time:timestamp" value="2026-06-15T08:00:00.000Z" />
        </event>
        <event>
          <string key="concept:name" value="Check" />
          <string key="lifecycle:transition" value="complete" />
          <string key="org:resource" value="Alice" />
          <date key="time:timestamp" value="2026-06-15T08:07:00.000Z" />
        </event>
      </trace>
    </log>
  `;

  const dataset = parseEventLogText(xes, 'log.xes');

  assert.equal(dataset.records.length, 1);
  assert.equal(dataset.records[0].caseId, 'Case-1');
  assert.equal(dataset.records[0].activityName, 'Check');
  assert.equal(dataset.records[0].resource, 'Alice');
  assert.equal(dataset.records[0].endTime?.toISOString(), '2026-06-15T08:07:00.000Z');
});

test('parseEventLogText imports MXML audit trail entries', () => {
  const mxml = `
    <WorkflowLog>
      <Process id="P1">
        <ProcessInstance id="Case-2">
          <AuditTrailEntry>
            <WorkflowModelElement>Approve</WorkflowModelElement>
            <EventType>start</EventType>
            <Timestamp>2026-06-15T09:00:00.000Z</Timestamp>
            <Originator>Bob</Originator>
          </AuditTrailEntry>
          <AuditTrailEntry>
            <WorkflowModelElement>Approve</WorkflowModelElement>
            <EventType>complete</EventType>
            <Timestamp>2026-06-15T09:10:00.000Z</Timestamp>
            <Originator>Bob</Originator>
          </AuditTrailEntry>
        </ProcessInstance>
      </Process>
    </WorkflowLog>
  `;

  const dataset = parseEventLogText(mxml, 'log.mxml');

  assert.equal(dataset.records.length, 1);
  assert.equal(dataset.records[0].caseId, 'Case-2');
  assert.equal(dataset.records[0].activityName, 'Approve');
  assert.equal(dataset.records[0].resource, 'Bob');
  assert.equal(dataset.records[0].processId, 'P1');
});
