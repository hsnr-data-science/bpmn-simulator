export type EventLogRecord = {
  caseId: string;
  activityId: string;
  activityName: string;
  startTime: Date;
  endTime?: Date;
  resource?: string;
  resourceInstance?: string;
  variables?: Record<string, unknown>;
  processId?: string;
  sequence: number;
};

export type EventLogDataset = {
  sourceName: string;
  sourceKind: 'simulation' | 'upload';
  importedAt: Date;
  records: EventLogRecord[];
  warnings: string[];
};

export type EventLogMappingTarget =
  | 'ignore'
  | 'caseId'
  | 'activityId'
  | 'activityName'
  | 'startTime'
  | 'endTime'
  | 'lifecycleTransition'
  | 'resource'
  | 'processId'
  | 'variables';

export type EventLogImportMapping = Partial<Record<Exclude<EventLogMappingTarget, 'ignore'>, string>>;

export type EventLogTimestampFormat =
  | 'auto'
  | 'iso'
  | 'yyyy-MM-dd HH:mm:ss'
  | 'yyyy-MM-dd HH:mm:ss.SSSSSSXXX'
  | 'yyyyMMddTHHmm'
  | 'dd.MM.yyyy HH:mm:ss'
  | 'dd/MM/yyyy HH:mm:ss'
  | 'MM/dd/yyyy HH:mm:ss'
  | 'epochMillis'
  | 'epochSeconds';

export type EventLogInstantRecordHandling = 'event' | 'activity';

export type EventLogImportOptions = {
  timestampFormat?: EventLogTimestampFormat;
  instantRecordHandling?: EventLogInstantRecordHandling;
};

export type EventLogImportPreview = {
  sourceName: string;
  sourceFormat: 'csv' | 'json';
  fields: string[];
  rows: Array<Record<string, unknown>>;
  suggestedMapping: EventLogImportMapping;
  warnings: string[];
};

export type EventLogImportPreparation =
  | {
      kind: 'mapped';
      preview: EventLogImportPreview;
    }
  | {
      kind: 'dataset';
      dataset: EventLogDataset;
    };
