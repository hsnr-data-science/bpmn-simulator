/// <reference types="vite/client" />

declare module 'bpmn-js/lib/Modeler' {
  export default class BpmnModeler {
    constructor(options: Record<string, unknown>);
    importXML(xml: string): Promise<{ warnings: unknown[] }>;
    saveXML(options?: Record<string, unknown>): Promise<{ xml: string }>;
    saveSVG(options?: Record<string, unknown>): Promise<{ svg: string }>;
    get<T = unknown>(name: string): T;
    on(event: string, callback: (...args: unknown[]) => void): void;
    destroy(): void;
  }
}

declare module 'bpmn-js-token-simulation';
declare module 'bpmn-js/dist/assets/diagram-js.css';
declare module 'bpmn-js/dist/assets/bpmn-js.css';
declare module 'bpmn-js/dist/assets/bpmn-font/css/bpmn-embedded.css';
declare module 'bpmn-js-token-simulation/assets/css/bpmn-js-token-simulation.css';
declare module '@bpmn-io/properties-panel/assets/properties-panel.css';

declare module 'bpmn-js-properties-panel' {
  export const BpmnPropertiesPanelModule: unknown;
  export const BpmnPropertiesProviderModule: unknown;
  export function useService<T = unknown>(name: string): T;
}

declare module '@bpmn-io/properties-panel' {
  export function TextFieldEntry(props: Record<string, unknown>): unknown;
  export function SelectEntry(props: Record<string, unknown>): unknown;
  export function CheckboxEntry(props: Record<string, unknown>): unknown;
  export function isTextFieldEntryEdited(...args: unknown[]): boolean;
  export function isSelectEntryEdited(...args: unknown[]): boolean;
  export function isCheckboxEntryEdited(...args: unknown[]): boolean;
}
