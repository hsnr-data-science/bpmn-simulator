# BPMN DES Simulator

Leichtgewichtige webbasierte BPMN-Simulationsumgebung auf Basis von `bpmn-js`, `bpmn-js-token-simulation` und `bpmn-js-properties-panel`.

Die Token-Simulation bleibt als bpmn-js-Modul eingebunden. Der zusätzliche DES-Kern liest stochastische Simulationsparameter aus BPMN Extension Elements (`sim:SimulationParameters`) und führt keine externen Service-, User- oder Script-Task-Aktionen aus.

## Start

```sh
npm install
npm run dev
```

## Build

```sh
npm run build
```

## Modellierte Simulationsparameter

Die Parameter werden im BPMN XML unter `bpmn:extensionElements` gespeichert, z. B.:

```xml
<sim:SimulationParameters durationDistribution="triangular" durationMin="2" durationMode="5" durationMax="10" errorProbability="0.03" />
```

Unterstützt sind unter anderem Bearbeitungszeit-Verteilungen, Fehler-/Retry-Wahrscheinlichkeiten, Ressourcen-Kapazitäten, Retry-Delay, Gateway-/Sequence-Flow-Wahrscheinlichkeiten und simulierte Output-Werte.
