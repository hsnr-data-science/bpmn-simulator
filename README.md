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
      ServiceTaskErrorEntry.ts
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
<bpmn:process id="Process_Order_Fulfillment" name="Order Fulfillment DES Demo">
  <bpmn:extensionElements>
    <sim:resourceCatalog>
      <sim:resource
        id="clerk"
        name="Clerk Team"
        capacity="2"
        weekdays="1,2,3,4,5"
        hourRanges="8-17" />
    </sim:resourceCatalog>
  </bpmn:extensionElements>
</bpmn:process>

<bpmn:extensionElements>
    <sim:taskConfig>
      <sim:duration type="normal" mean="10" stddev="2" />
      <sim:resource id="clerk" />
      <sim:outputObject>
        <sim:outputField
          key="score"
          type="int"
          generator="normal"
          mean="10"
          stddev="2"
          min="0" />
        <sim:outputField
          key="status"
          type="string"
          generator="categorical"
          choices="ok:0.8|manual:0.2" />
      </sim:outputObject>
      <sim:failure probability="0.02" retryCount="2">
        <sim:retryDelay type="fixed" mean="1" />
      </sim:failure>
  </sim:taskConfig>
</bpmn:extensionElements>

<bpmn:sequenceFlow id="Flow_Manual_Check" sourceRef="Gateway_Check" targetRef="Task_Manual_Check">
  <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" language="JavaScript">
    status === "manual"
  </bpmn:conditionExpression>
</bpmn:sequenceFlow>
```

Editierbar im Properties Panel sind:

- Tasks: dynamische Dauerverteilung `fixed`, `uniform`, `normal`, `exponential`, `triangular`; je nach Auswahl werden nur die passenden Parameterfelder angezeigt. Dazu kommen Ressourcenauswahl per Dropdown, Fehlerwahrscheinlichkeit, Retry-Anzahl und Retry-Delay.
- User Tasks, Script Tasks, Receive Tasks und Service Tasks: einfache Output-Objekte als Key-Value-Liste.
- Service Tasks: zusaetzlich Fehlerwahrscheinlichkeit und mögliche Fehlercodes; stochastische Outputs werden ueber Output-Objects modelliert.
- Sequence Flows: JavaScript-Condition als BPMN `conditionExpression` im Documentation-Bereich und Branch-Wahrscheinlichkeit im DES-Bereich für XOR-Gateways ohne Bedingungen.
- Start Events: Ankunftsverteilung, Intervall-/Mittelwert-/Schedule-Felder und Anzahl der Cases.

Globale Ressourcen werden in einem eigenen einklappbaren Ressourcenbereich der Anwendung gepflegt. Jede Ressource besitzt ID, Name, Kapazität und Verfügbarkeitskalender/Arbeitszeiten. Tasks speichern nur die Resource-ID als Referenz; Kapazität und Kalender werden beim Aufbau des Simulationsmodells aus dem globalen Katalog aufgelöst.

Arbeitszeiten werden ausschliesslich strukturiert gespeichert: `weekdays` nutzt `1=Montag` bis `7=Sonntag`, `hourRanges` nutzt stundenweise Bereiche von `0` bis `24`, z. B. `8-12,13-17`. Alte Freitext-Working-Hours bzw. `calendar`-Attribute werden nicht mehr geschrieben oder als Fallback ausgewertet. In der Simulation gilt `t=0` als Montag 00:00; Ressourcen starten Tasks nur innerhalb ihrer Arbeitszeiten, und Bearbeitungszeit zählt als Arbeitszeit über Kalendergrenzen hinweg weiter.

Output-Objekte sind bewusst flach und enthalten keine verschachtelten JSON-Strukturen. Im Properties Panel werden sie als eigene einklappbare Liste gepflegt: Felder koennen hinzugefuegt oder entfernt werden, jedes Feld hat einen Namen, einen Typ und danach passende Generator-/Verteilungsparameter.

Unterstuetzte Feldtypen sind `int`, `float` und `string`. Zahlen koennen `fixed`, `randomChoice`, `uniform`, `normal`, `exponential` oder `triangular` nutzen. Strings koennen `random`, `fixed` oder `categorical` nutzen. Die UI blendet je nach Typ und Generator nur die passenden Parameter ein, z. B. Min/Max fuer `uniform`, Mean/Stddev fuer `normal`, Wertelisten fuer `randomChoice` und Kategorien fuer `categorical`. Neue Choice-Felder starten mit drei Beispielwerten (`1/2/3` bzw. `a/b/c`), damit die Syntax sichtbar ist.

Die Konfiguration liegt als generisches `sim:outputObject` in den BPMN Extension Elements vor und kann spaeter auch an Event-Konfigurationen wiederverwendet werden.

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

Wenn ausgehende Sequence Flows Bedingungen haben, werden Bedingungen vorrangig behandelt. Conditions werden als einfache JavaScript-Ausdruecke ausgewertet, z. B. `status === "ok"` oder `outputs.Task_Check_Order.priority >= 2`. Output-Object-Felder vorheriger Activities stehen flach als Prozessvariablen zur Verfuegung; zusaetzlich sind die verschachtelten Objekte ueber `outputs`, `outputObjects` bzw. `processVariables` erreichbar. Falls keine Bedingung wahr ist, wird der Default Flow verwendet. Existiert kein Default Flow, erzeugt die Simulation eine Warnung.

Wenn keine Bedingungen vorhanden sind, nutzt der Interpreter `branchProbability` aus den Extension Elements. Fehlende Wahrscheinlichkeiten werden gleichverteilt gewählt und als Warnung geloggt. Summen ungleich `1` werden normalisiert und ebenfalls als Warnung sichtbar gemacht.

## Visualisierung und UI

Die Oberfläche enthält:

- BPMN Modeler mit Properties Panel
- Simulation Control Panel mit Start, Pause, Step, Stop, Reset und Run Monte Carlo
- Einstellungen für Anzahl Cases, Seed, maximale Simulationszeit und Animationsgeschwindigkeit
- Ressourcenbereich zum Bearbeiten von ID, Name, Kapazität, Wochentagen und stundenweisen Arbeitszeitbereichen
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

Das mitgelieferte BPMN-Beispiel enthält Start Event, zwei Tasks, XOR-Gateway mit Branch-Wahrscheinlichkeiten, Service Task mit Output-Object und End Event. Es wird beim Start der Anwendung automatisch geladen und kann direkt im Modeler bearbeitet werden.
