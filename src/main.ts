import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn-embedded.css';
import 'bpmn-js-token-simulation/assets/css/bpmn-js-token-simulation.css';
import '@bpmn-io/properties-panel/assets/properties-panel.css';
import './style.css';

import { ModelerApp } from './app/ModelerApp';

const app = document.querySelector<HTMLElement>('#app');

if (!app) {
  throw new Error('App root not found.');
}

void new ModelerApp(app).start();
