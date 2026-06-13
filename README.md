# BPMN DES Simulator

Leichtgewichtige webbasierte BPMN-Simulationsumgebung auf Basis von `bpmn-js`, `bpmn-js-token-simulation` und `bpmn-js-properties-panel`.

Die Token-Simulation bleibt als bpmn-js-Modul eingebunden. Der zusätzliche DES-Kern liest stochastische Simulationsparameter aus BPMN Extension Elements im Namespace `https://hsnr.de/data-science/bpmn/simulation` und führt keine externen Service-, User- oder Script-Task-Aktionen aus. Service Tasks, User Tasks und andere Activities werden ausschließlich über Dauer, Fehler, Retry und Output simuliert.

## Start

```sh
npm install
npm run dev
```

## Build und Tests

```sh
npm run build
npm test
```

## Projektstruktur

```text
src/
  app/
    ModelerApp.ts
  simulation/
    DesEngine.ts
    EventQueue.ts
    SimulationClock.ts
    SimulationRunner.ts
    TokenStore.ts
    ResourceManager.ts
    StatisticsCollector.ts
    RandomDistributions.ts
    BpmnSimulationInterpreter.ts
  bpmn/
    BpmnGraphBuilder.ts
    BpmnElementClassifier.ts
    ExtensionElementReader.ts
    ExtensionElementWriter.ts
    defaultDiagram.ts
    simulationModdle.json
  properties/
    SimulationPropertiesProvider.ts
    entries/
      DurationDistributionEntry.ts
      BranchProbabilityEntry.ts
      ServiceTaskOutputEntry.ts
      ResourceEntry.ts
  visualization/
    TokenOverlayManager.ts
    HeatmapOverlayManager.ts
    SimulationLogPanel.ts
  types/
    simulation.ts
    bpmn.ts
```

## Simulationsparameter

Die Parameter werden im BPMN XML unter `bpmn:extensionElements` gespeichert:

```xml
<bpmn:extensionElements>
  <sim:taskConfig>
    <sim:duration type="normal" mean="10" stddev="2" />
    <sim:resource id="clerk" capacity="2" />
    <sim:failure probability="0.02" retryCount="2">
      <sim:retryDelay type="fixed" mean="1" />
    </sim:failure>
  </sim:taskConfig>
</bpmn:extensionElements>
```

Editierbar im Properties Panel sind:

- Tasks: Dauerverteilung `fixed`, `uniform`, `normal`, `exponential`, `triangular`, Ressourcen-ID, Kapazität, Kalender, Fehlerwahrscheinlichkeit, Retry-Anzahl und Retry-Delay.
- Service Tasks: stochastische Outputs, Output-Verteilung, Fehlerwahrscheinlichkeit und mögliche Fehlercodes.
- Sequence Flows: Branch-Wahrscheinlichkeit für XOR-Gateways ohne Bedingungen.
- Start Events: Ankunftsverteilung, Intervall-/Mittelwert-/Schedule-Felder und Anzahl der Cases.

## DES-Kern

Der Simulator nutzt eine eigene diskrete Ereignissimulation mit Priority Queue, `SimulationClock`, seedbarem Zufallsgenerator und diesen Eventtypen:

```text
CASE_ARRIVAL
TOKEN_ENTER_ELEMENT
TASK_START
TASK_COMPLETE
TIMER_FIRED
MESSAGE_RECEIVED
TOKEN_LEAVE_ELEMENT
PROCESS_INSTANCE_COMPLETE
TASK_FAILED
RETRY_TASK
```

`SimulationConfig` enthält `numberOfRuns`, `maxSimulationTime`, `randomSeed`, `animationSpeed` und `collectTraces`.

## BPMN-Unterstützung

MVP-Unterstützung:

- Start Event
- End Event
- Task, User Task, Service Task
- Exclusive Gateway
- Parallel Gateway
- Sequence Flow
- einfache Subprozesse als Container mit Start-/End-Logik
- Timer Intermediate Events als Verzögerung

Vorbereitet, aber noch nicht vollständig implementiert:

- Boundary Events
- Event Subprocesses
- Message Events
- Inclusive Gateways
- Multi-Instance Activities

Nicht unterstützte Elemente brechen die Simulation nicht ab. Sie erzeugen eine Warnung im Log Panel und werden im Diagramm markiert.

## XOR-Logik

Wenn ausgehende Sequence Flows Bedingungen haben, werden Bedingungen vorrangig behandelt. Die Methode `evaluateCondition(conditionExpression, context)` ist bewusst als Stub vorbereitet und liefert im MVP `false`; danach wird, falls vorhanden, der Default Flow verwendet. Existiert kein Default Flow, erzeugt die Simulation eine Warnung.

Wenn keine Bedingungen vorhanden sind, nutzt der Interpreter `branchProbability` aus den Extension Elements. Fehlende Wahrscheinlichkeiten werden gleichverteilt gewählt und als Warnung geloggt. Summen ungleich `1` werden normalisiert und ebenfalls als Warnung sichtbar gemacht.

## Visualisierung und UI

Die Oberfläche enthält:

- BPMN Modeler mit Properties Panel
- Simulation Control Panel mit Start, Pause, Step, Stop, Reset und Run Monte Carlo
- Einstellungen für Anzahl Cases, Seed, maximale Simulationszeit und Animationsgeschwindigkeit
- Ergebnisbereich mit Statistik-Tabelle, Event Log, Warnungen und Export Buttons

Die Visualisierung markiert aktive Tokens, aktuelle Task-Ausführungen, abgeschlossene Pfade und Heatmap-Werte nach Häufigkeit, mittlerer Wartezeit und mittlerer Bearbeitungszeit.

## Statistik und Export

`StatisticsCollector` erfasst:

- Durchlaufzeit pro Prozessinstanz
- Aktivitätsauslastung
- Wartezeiten und Bearbeitungszeiten
- Token-Anzahl pro Element
- Pfadwahrscheinlichkeiten
- Fehlerhäufigkeiten
- abgeschlossene und abgebrochene Instanzen
- Deadlock-Verdachtsfälle
- nicht konsumierte Tokens am Simulationsende

Exporte sind als JSON, CSV und XES-ähnliches Event Log vorbereitet.

## Beispielmodell

Das mitgelieferte BPMN-Beispiel enthält Start Event, zwei Tasks, XOR-Gateway mit Branch-Wahrscheinlichkeiten, Service Task mit Output-Verteilung und End Event. Es wird beim Start der Anwendung automatisch geladen und kann direkt im Modeler bearbeitet werden.
