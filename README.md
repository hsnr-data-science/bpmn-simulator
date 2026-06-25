# BPMN DES Simulator

Leichtgewichtige webbasierte BPMN-Simulationsumgebung auf Basis von `bpmn-js`, `bpmn-js-token-simulation` und `bpmn-js-properties-panel`.

Die Token-Simulation bleibt als bpmn-js-Modul eingebunden. Der zusätzliche DES-Kern liest stochastische Simulationsparameter aus BPMN Extension Elements im Namespace `https://hsnr.de/data-science/bpmn/simulation` und führt keine externen Service-, User- oder Script-Task-Aktionen aus. Service Tasks, User Tasks und andere Activities werden ausschließlich über Dauer, Fehler, Retry und Output simuliert. Bearbeitungszeiten und Delay-Dauern werden in Minuten konfiguriert; die interne DES-Uhr bleibt fuer Kalender, Arbeitszeiten und Datum/Uhrzeit in Stunden.

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
    SimulationTimelineBuilder.ts
  playback/
    TimelineFrameBuilder.ts
    PlaybackController.ts
    VisualStateStore.ts
    EventLogImporter.ts
  bpmn/
    BpmnGraphBuilder.ts
    BpmnElementClassifier.ts
    ExtensionElementReader.ts
    ExtensionElementWriter.ts
    QbpSimulationImporter.ts
    demoModels.ts
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
    TimelineOverlayRenderer.ts
    SimulationLogPanel.ts
  types/
    simulation.ts
    bpmn.ts
    timeline.ts
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

- Tasks: dynamische Dauerverteilung `fixed`, `uniform`, `normal`, `exponential`, `triangular`; je nach Auswahl werden nur die passenden Parameterfelder angezeigt. Dauerwerte sind Minuten und erlauben Dezimalzahlen, z. B. `0.1` fuer 6 Sekunden. Dazu kommen Ressourcenauswahl per Dropdown, Fehlerwahrscheinlichkeit, Retry-Anzahl und Retry-Delay.
- User Tasks, Script Tasks, Receive Tasks und Service Tasks: einfache Output-Objekte als Key-Value-Liste.
- Service Tasks: zusaetzlich Fehlerwahrscheinlichkeit und mögliche Fehlercodes; stochastische Outputs werden ueber Output-Objects modelliert.
- Sequence Flows: JavaScript-Condition als BPMN `conditionExpression` im Documentation-Bereich und Branch-Wahrscheinlichkeit im DES-Bereich für XOR-Gateways ohne Bedingungen.
- Start Events: Ankunftsverteilung `None`, `Fixed`, `Normal` oder `Exponential`, Anzahl der Cases und Ankunftskalender. Werte werden in Minuten eingegeben. `None` erzeugt keine Tokens und ist fuer Message-/Signal-Starts gedacht. Message-/Signal-Start-Events werden nicht automatisch aus Arrival-Konfigurationen gestartet, sondern nur durch passende Messages bzw. Signals. Neue Arrival-Kalender verwenden standardmaessig Montag bis Freitag, 8-17 Uhr.

Globale Ressourcen werden in einem eigenen einklappbaren Ressourcenbereich der Anwendung gepflegt. Jede Ressource besitzt ID, Name, Kapazität und Verfügbarkeitskalender/Arbeitszeiten. Tasks speichern nur die Resource-ID als Referenz; Kapazität und Kalender werden beim Aufbau des Simulationsmodells aus dem globalen Katalog aufgelöst.

Arbeitszeiten werden ausschliesslich strukturiert gespeichert: `weekdays` nutzt `1=Montag` bis `7=Sonntag`, `hourRanges` nutzt stundenweise Bereiche von `0` bis `24`, z. B. `8-12,13-17`. Alte Freitext-Working-Hours bzw. `calendar`-Attribute werden nicht mehr geschrieben oder als Fallback ausgewertet. In der Simulation gilt `t=0` als Montag 00:00; Ressourcen starten Tasks nur innerhalb ihrer Arbeitszeiten, und Bearbeitungszeit zählt als Arbeitszeit über Kalendergrenzen hinweg weiter.

Output-Objekte sind bewusst flach und enthalten keine verschachtelten JSON-Strukturen. Im Properties Panel werden sie als eigene einklappbare Liste gepflegt: Felder koennen hinzugefuegt oder entfernt werden, jedes Feld hat einen Namen, einen Typ und danach passende Generator-/Verteilungsparameter.

Unterstuetzte Feldtypen sind `int`, `float` und `string`. Zahlen koennen `fixed`, `randomChoice`, `uniform`, `normal`, `exponential` oder `triangular` nutzen. Strings koennen `random`, `fixed` oder `categorical` nutzen. Die UI blendet je nach Typ und Generator nur die passenden Parameter ein, z. B. Min/Max fuer `uniform`, Mean/Stddev fuer `normal`, Wertelisten fuer `randomChoice` und Kategorien fuer `categorical`. Neue Choice-Felder starten mit drei Beispielwerten (`1/2/3` bzw. `a/b/c`), damit die Syntax sichtbar ist.

Die Konfiguration liegt als generisches `sim:outputObject` in den BPMN Extension Elements vor und kann spaeter auch an Event-Konfigurationen wiederverwendet werden.

## DES-Kern

Der Simulator nutzt eine eigene diskrete Ereignissimulation mit Priority Queue, `SimulationClock`, seedbarem Zufallsgenerator und diesen Eventtypen:

```text
CASE_ARRIVAL
EXTERNAL_EVENT_OCCURRED
TOKEN_ENTER_ELEMENT
TASK_START
TASK_COMPLETE
TIMER_FIRED
MESSAGE_RECEIVED
SIGNAL_RECEIVED
TOKEN_LEAVE_ELEMENT
PROCESS_INSTANCE_COMPLETE
TASK_FAILED
RETRY_TASK
```

`SimulationConfig` enthält `numberOfRuns`, optionales `maxSimulationTime`, `startTime`, `startDateTime`, `endDateTime`, `randomSeed`, `animationSpeed` und `collectTraces`. In der UI gibt es keine globale Case-Anzahl mehr; die Anzahl der Prozessinstanzen wird pro Start Event über dessen `numberOfCases` gepflegt. Die UI berechnet den optionalen Zeithorizont aus der eingestellten Endzeit; eine leere Endzeit bedeutet unbegrenzt.

## Timeline Playback

Die DES-Engine steuert keine Visualisierung direkt an. Sie erzeugt nach dem Lauf ein geordnetes Event Log als `SimulationEvent[]`, das im JSON-Export unter `timeline` enthalten ist. Die Animation darf die Simulation nicht treiben. Die Simulationstimeline muss die Animation treiben.

Der Datenfluss ist:

```text
Simulation -> SimulationEvent Timeline -> TimelineFrame[] -> PlaybackController -> VisualState -> bpmn-js Overlay Rendering
```

`SimulationEvent` ist die zentrale Schnittstelle zwischen DES und Playback. Es enthält Simulationszeit, stabile Sequenznummer, Prozessinstanz, optionale Token-ID, BPMN-Elemente und Payload. Fachliche DES-Events wie `TASK_STARTED`, `TASK_COMPLETED`, `GATEWAY_DECISION` oder `PROCESS_INSTANCE_COMPLETED` werden zusammen mit rein visuellen Bewegungsereignissen `TOKEN_MOVE_START` und `TOKEN_MOVE_END` in derselben Timeline abgelegt. Diese Bewegungsereignisse verbrauchen keine fachliche Prozesszeit; sie dienen nur dem Playback.

`TimelineFrameBuilder` sortiert die Events nach `simulationTime` und `sequence` und gruppiert alle Events mit gleicher Simulationszeit zu atomaren Frames. Dadurch starten parallele Tokenbewegungen, etwa nach einem Parallel Gateway, im selben Visualisierungsschritt synchron.

`PlaybackController` besitzt die einzige Playback-Uhr. Play, Pause, Step, Seek und Speed ändern nur diese Uhr. Tokens werden nicht mehr mit eigenen `setTimeout`-Ketten, Promises oder CSS-Transitionen animiert.

`VisualStateStore` rekonstruiert den aktuellen Zustand deterministisch aus Event Log und Playback-Zeit: sichtbare Tokens, aktive Elemente, abgeschlossene Elemente, wartende Tokens und Warnungen. `TimelineOverlayRenderer` rendert diesen Zustand idempotent als bpmn-js/SVG-Overlay. Ein importiertes Event Log kann über `EventLogImporter` validiert und mit demselben FrameBuilder und PlaybackController abgespielt werden.

## BPMN-Unterstützung

MVP-Unterstützung:

- Start Event
- End Event
- Task, User Task, Service Task
- Exclusive Gateway
- Parallel Gateway
- Event-Based Gateway mit konkurrierenden Message-, Signal- und Timer-Catch-Events
- Sequence Flow
- einfache Subprozesse als Container mit Start-/End-Logik
- Timer Intermediate Events als Verzögerung
- Collaborations mit mehreren BPMN-Prozessen/Pools
- Message Start Events, Message Intermediate Catch/Throw Events und Message End Events
- Signal Start Events, Signal Intermediate Catch/Throw Events und Signal End Events

Vorbereitet, aber noch nicht vollständig implementiert:

- Boundary Events
- Event Subprocesses
- Message/Signal Boundary Events
- Inclusive Gateways
- Multi-Instance Activities

Nicht unterstützte Elemente brechen die Simulation nicht ab. Sie erzeugen eine Warnung im Log Panel und werden im Diagramm markiert.

Message-Flows in einer Collaboration werden als gezielte Zustellung zwischen Prozessinstanzen interpretiert. Message Start Events erzeugen neue Prozessinstanzen nur durch passende Messages, Message Catch Events warten auf passende Messages; noch nicht konsumierte Messages werden für spätere Catch Events gepuffert. Child-Prozesse erhalten die `parentCaseId` als Prozessvariable. Signals werden als Broadcast behandelt und starten alle passenden Signal Start Events bzw. wecken passende wartende Signal Catch Events. Event-Based Gateways registrieren ihre ausgehenden Message-, Signal- und Timer-Catch-Events als konkurrierende Race; das erste eintretende Event setzt den Case fort und storniert die übrigen Alternativen. Zufällige externe Ereignisse werden über nicht korrelierte Start Events mit Arrival-Konfiguration modelliert, nicht über Message-/Signal-Start-Events.

## XOR-Logik

Wenn ausgehende Sequence Flows Bedingungen haben, werden Bedingungen vorrangig behandelt. Conditions werden als einfache JavaScript-Ausdruecke ausgewertet, z. B. `status === "ok"` oder `outputs.Task_Check_Order.priority >= 2`. Output-Object-Felder vorheriger Activities stehen flach als Prozessvariablen zur Verfuegung; zusaetzlich sind die verschachtelten Objekte ueber `outputs`, `outputObjects` bzw. `processVariables` erreichbar. Falls keine Bedingung wahr ist, wird der Default Flow verwendet. Existiert kein Default Flow, erzeugt die Simulation eine Warnung.

Wenn keine Bedingungen vorhanden sind, nutzt der Interpreter `branchProbability` aus den Extension Elements. Fehlende Wahrscheinlichkeiten werden gleichverteilt gewählt und als Warnung geloggt. Summen ungleich `1` werden normalisiert und ebenfalls als Warnung sichtbar gemacht.

## Visualisierung und UI

Die Oberfläche enthält:

- BPMN Modeler mit Properties Panel
- Simulation Control Panel mit Start, Pause, Step backward, Step forward, Stop und Reset
- Einstellungen für Seed, Startzeit, optionale Endzeit, aktuelle Simulationszeit und Animationsgeschwindigkeit
- Speed-Regler mit den Stufen `1x`, `2x`, `4x`, `8x`, `16x`, `64x`, `256x` und `1024x`; `1x` nutzt eine verlangsamte Playback-Basis von zwei Hundertsteln der urspruenglichen Geschwindigkeit
- Ressourcenbereich zum Bearbeiten von ID, Name, Kapazität, Wochentagen und stundenweisen Arbeitszeitbereichen
- einklappbare linke Sidebar-Bereiche fuer Übersicht, Ressourcen, Bottlenecks, Pfade, Statistik, Event Log, Warnungen und Export
- größenänderbare linke und rechte Sidebar
- Ergebnisbereich mit Statistik-Tabelle, Event Log, Warnungen und Export Buttons
- separater Dashboard-Tab mit interaktiven Plotly-Diagrammen

Wenn der bpmn-js-token-simulation-Schalter auf AN steht, erzeugt der obere Start-Button zuerst den vollständigen DES-Lauf und spielt danach dessen Timeline über den zentralen PlaybackController im Diagramm ab. Der urspruengliche interaktive Simulator aus bpmn-js-token-simulation wird nicht geladen; dessen Event-Trigger, Task-Pausen, Gateway-Umschaltungen, Reset/Pause-Controls und Event-Log sind entfernt. Waehrend des Abspielens aktualisieren sich Statistik, Task-Wartezeitboxen, Task-Fehlerzaehler, Event-/Gateway-Haeufigkeiten, Aktivitaetsfarben und Kantenstaerken fortlaufend.

## Statistik und Export

`StatisticsCollector` erfasst:

- Durchlaufzeit pro Prozessinstanz
- Aktivitätsauslastung
- Wartezeiten und Bearbeitungszeiten
- Ressourcen-Auslastung mit Task-Anzahl, Fehlern, Bearbeitungszeit- und Wartezeitverteilungen je Ressource
- Token-Anzahl pro Element
- Pfadwahrscheinlichkeiten
- Fehlerhäufigkeiten
- abgeschlossene und abgebrochene Instanzen
- Deadlock-Verdachtsfälle
- nicht konsumierte Tokens am Simulationsende

Exporte sind als JSON, Simulation Results CSV und Event Log CSV vorbereitet. Beide CSV-Formate verwenden Semikolon als Trennzeichen. Das Event Log CSV enthält CaseID, Task-/Event-ID, Name, Startzeit, Endzeit für Tasks, Resource für Tasks und die aktuellen Prozessvariablen als JSON-String.

Der Dashboard-Tab visualisiert Service- und Wartezeiten für den Gesamtprozess, jeden Task und jede Ressource. Die Prozess-Wartezeit ist die Summe aller Task-Wartezeiten je Prozessinstanz. Ein gruppiertes Balkendiagramm vergleicht Min, Max, Durchschnitt und Median. Zwei interaktive Plotly-Verteilungsdiagramme zeigen die Rohwerte für Service- und Wartezeiten und können gemeinsam zwischen Box- und Violin-Plots umgeschaltet werden. Der Scope kann zwischen Gesamtansicht, Prozess, Tasks und Ressourcen umgeschaltet werden.

## Beispielmodell

Die Demo-Auswahl lädt die BPMN-Dateien direkt aus `tests/bpmn`: das einfache Order-Fulfillment-Modell, das Messaging-/Signal-Modell mit mehreren Pools und Event-Based Gateway sowie das Insurance-Claims-Modell für den QBP-Import. Das ausgewählte Modell wird über den Demo-Button geladen und kann direkt im Modeler bearbeitet werden.

Beim Import eines BIMP/QBP-Modells mit `qbp:processSimulationInfo` werden unterstützte Simulationsdaten automatisch in die nativen `sim:*`-Extension-Elements des Simulators migriert. Übernommen werden Prozessinstanzen und Arrival-Verteilung, Startzeit, Ressourcen und Timetables, Aktivitätsdauern und Ressourcenzuordnungen sowie Sequence-Flow-Wahrscheinlichkeiten. QBP-Kostenparameter werden derzeit nicht simuliert und als Importwarnung angezeigt. Der QBP-Block und sein Namespace werden vor dem bpmn-js-Import entfernt; ein anschließend exportiertes BPMN enthält deshalb ausschließlich die eigenen Simulationsannotationen.
