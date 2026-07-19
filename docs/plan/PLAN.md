# Plan de trabajo — jira-lite-mcp

> Documento vivo.
> Última actualización: 2026-07-18

---

## 1. Tesis del proyecto

`jira-lite-mcp` es un servidor MCP **genérico para cualquier Jira Cloud**, orientado a
productividad con Claude Code.

No conoce proyectos, ni épicas, ni custom fields concretos. Nada específico de una instancia
se hornea en el código: eso vive en la guía de cada repo que lo consume.

Lo que sí aporta frente al MCP oficial de Atlassian:

1. **Pocas herramientas de alto valor** en vez de decenas de wrappers 1:1 de la API.
2. **Respuestas optimizadas para LLM**: sin `self`, `avatarUrls`, `iconUrl`, `18n` ni el resto
   del ruido que Jira devuelve por defecto.
3. **Campos por nombre, no por id**: el usuario escribe `"Criterios de aceptación"` y el
   servidor resuelve `customfield_10064` contra *esa* instancia.
4. **Normalización de los formatos raros de Jira**: ADF ↔ texto plano, tiempos, paginación.

**Regla de diseño:** si una decisión requiere saber cómo se llama un proyecto, un estado o un
campo en una instancia concreta, esa decisión **no pertenece al código**. Pertenece a un
parámetro o a la guía del repo consumidor.

---

## 2. Qué aportó el análisis de las guías

Las tres `JIRA_GUIDE.md` analizadas (proyecto LAN) no definen el diseño, pero sí revelan
**qué campos se usan de verdad en el día a día** y por tanto qué debe devolver una respuesta
útil sin cargar con lo irrelevante:

- **Lectura habitual:** key, summary, status, priority, assignee, updated, issuetype, parent,
  labels, estimación, criterios de aceptación (custom), subtareas, enlaces.
- **Ignorable siempre:** avatares, urls internas, `self`, ids numéricos redundantes,
  metadatos de renderizado.
- **Escritura habitual:** crear issue con parent + custom fields, transicionar, comentar,
  registrar worklog, enlazar issues.
- **Formatos que muerden:** ADF en `description` y comentarios; custom fields que a veces son
  texto plano y a veces ADF **según cómo estén configurados en la instancia**; unidades de
  tiempo dependientes de la jornada configurada en el sitio.

Ese último punto es clave: el tipo de un custom field **no se adivina, se consulta**
(`schema.type` en `/rest/api/3/field`). Es la diferencia entre un MCP que funciona en
cualquier sitio y uno que funciona en el mío.

---

## 3. Principios de arquitectura (confirmados)

Se mantienen tal cual:

- `tools/` **solo** traduce MCP ↔ dominio. Cero HTTP, cero lógica Jira.
- `jira/` **solo** habla con Jira. Cero conocimiento de MCP.
- `types/jira.ts` define contratos propios; nunca se filtra un objeto crudo de Jira.
- Errores siempre vía `jira/error.ts`.
- TypeScript strict, ESM, imports con `.js`.
- `npm run build` verde antes de cerrar cualquier paso.

Configuración: **solo** `JIRA_URL`, `JIRA_EMAIL`, `JIRA_TOKEN`. Nada más es obligatorio.
Opcionalmente `JIRA_DEFAULT_PROJECT` como comodidad para no repetir la key en cada llamada.

---

## 4. Deuda técnica detectada en el código actual

- **`src/jira/issues.ts`** tipa `description` como `string | null`, pero la API v3 devuelve un
  **documento ADF** (objeto). Se está tratando un objeto como si fuera texto.
- **`src/jira/search.ts`** usa `POST /rest/api/3/search/jql`, endpoint que **ya no devuelve
  `total`**. **Confirmado empíricamente (2026-07-18):** la respuesta solo trae las claves
  `issues`, `nextPageToken` e `isLast`. El `total` que devuelve `jira_search` hoy es
  `undefined`.
- `createJiraClient()` se instancia en cada llamada. Funciona; **no se toca** hasta que haya
  un motivo real. No es un refactor que el proyecto necesite ahora.

---

## 5. Orden de ejecución

Las fases describen el **alcance**, no el orden. El orden lo marca el primer flujo real que
el proyecto debe soportar: **crear un issue de cualquier tipo con los campos que le
corresponden**.

| # | Tarea | Fase | Por qué en esta posición |
|---|---|---|---|
| 1 | ✅ `jira_issue_fields` | 2 | Prerrequisito de la creación: sin el contrato de campos, crear es adivinar. Lectura pura, sin riesgo. |
| 2 | ✅ `jira_create_issue` | 2 | Consume el contrato de la tarea 1 y valida antes del POST. |
| 3 | `adf.ts` | 0 | Necesario en cuanto se escriben descripciones y se leen issues creados. |
| 4 | ✅ `jira_transition_issue` | 2 | Cierra el ciclo mínimo de trabajo sobre un issue. |
| 5 | Deuda de `search.ts` / `issues.ts` | 0 | Se corrige cuando estorbe; hoy no bloquea la creación. |
| 6 | `jira_my_work`, `project_summary`, `explain_issue` | 1 | Lectura inteligente, una vez el ciclo de escritura funciona. |

---

## 6. Fases

Cada fase cierra con: `npm run build` verde, tool visible en MCP Inspector, respuesta
verificada contra un Jira real.

---

### Fase 0 — Cimientos

Sin herramientas nuevas de cara al usuario. Arregla lo que todo lo demás da por hecho.

**`src/jira/adf.ts`** (nuevo)
- `adfToText(doc: unknown): string | null` — aplana ADF a texto legible. Tolerante: si recibe
  un string (campo de texto plano), lo devuelve tal cual.
- `textToAdf(text: string): AdfDocument` — para escritura en Fase 2.

**`src/jira/fields.ts`** (nuevo)
- `GET /rest/api/3/field` → catálogo global de campos de la instancia.
- Cache en memoria por proceso (el catálogo no cambia durante una sesión).
- `resolveField(nameOrId): FieldRef` — acepta `"Criterios de aceptación"`,
  `"criterios de aceptacion"` (sin acentos, case-insensitive) o `"customfield_10064"`.
- Expone `schema.type` para saber si un custom field es `string`, `doc` (ADF), `number`,
  `option`, `array`… y serializar en consecuencia **sin adivinar**.

> Alcance acotado: para **crear** issues, `createmeta` (§ Tarea 1) da los campos por proyecto
> y tipo, que es más preciso que este catálogo global y lo subsume. `fields.ts` sirve a los
> contextos donde no hay createmeta: lectura de issues y selección de campos en búsquedas.

**Correcciones**
- `search.ts`: dejar de leer `total` inexistente; paginación honesta.
- `issues.ts` y `search.ts`: pasar `description` por `adfToText`.

**Criterio de cierre:** `jira_get_issue` sobre un issue con descripción rica devuelve texto
legible. `jira_search` devuelve un `total` real.

---

### Fase 1 — Lectura

#### 1.1 `jira_my_work`

Responde a *"¿qué tengo pendiente en Jira?"*.

- `src/jira/users.ts` (nuevo) — `getCurrentUser()` vía `GET /rest/api/3/myself`.
- `src/jira/my-work.ts` (nuevo) — construye el JQL y **reutiliza la capa de búsqueda
  existente**; no duplica el fetch.
- `src/tools/my-work.ts` (nuevo).

JQL base:
```
assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC
```

> Se filtra por **`statusCategory`**, no por `status != Done`. La categoría es un invariante
> de Jira (`To Do` / `In Progress` / `Done`); el nombre del estado depende del workflow y del
> idioma del sitio — en un sitio en español el estado final puede llamarse `Finalizada`,
> `Cerrada` o cualquier cosa. Es exactamente el tipo de suposición que rompe la portabilidad.

Parámetros opcionales: `project`, `limit`, `includeDone`.

#### 1.2 `jira_project_summary`

Resumen ejecutivo de un proyecto (key como parámetro): total de abiertos, distribución por
estado y por tipo, bugs abiertos por prioridad, sin asignar, stale (sin actualizar > N días).

El agregado se hace **en nuestra capa** a partir de una búsqueda, no con N llamadas a Jira.
Aporta valor sobre `jira_search` porque agregar a mano es justo lo caro.

Sin heurísticas opinadas de "riesgo": se devuelven hechos, Claude interpreta.

#### 1.3 `jira_explain_issue`

Entrega el issue **con todo su contexto en una sola llamada**: descripción en texto plano,
subtareas, enlaces, comentarios recientes, transiciones disponibles, y los custom fields que
el usuario pida por nombre (`extraFields: ["Criterios de aceptación", "Story Points"]`).

No genera prosa explicativa — eso lo hace Claude. Entrega el material limpio y completo.

---

### Fase 2 — Escritura

Herramientas genéricas. Ningún campo obligatorio hardcodeado: lo que cada instancia exija se
descubre o se pasa como parámetro.

#### 2.0 `jira_issue_fields` — **primera tarea del proyecto**

Responde: *"¿qué campos puedo y debo rellenar para crear un issue de tipo X en el proyecto Y?"*

- `src/jira/meta.ts` (nuevo) — envuelve los endpoints de createmeta:
  - `GET /rest/api/3/issue/createmeta/{projectIdOrKey}/issuetypes` → tipos del proyecto.
  - `GET /rest/api/3/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}` → campos.
  (El antiguo `GET /rest/api/3/issue/createmeta` con `expand` está retirado en Jira Cloud.)
- `src/tools/issue-fields.ts` (nuevo).

**Entrada:** `project` (key), `issueType` opcional (nombre o id).

**Salida sin `issueType`** — los tipos disponibles:
```json
{ "project": "LAN",
  "issueTypes": [ { "id": "10001", "name": "Historia", "subtask": false } ] }
```

**Salida con `issueType`** — el contrato de campos, ya filtrado de ruido
(`operations`, `autoCompleteUrl`, `scope`) y con `allowedValues` compactados a nombre:
```json
{ "project": "LAN", "issueType": "Historia",
  "fields": [
    { "id": "summary", "name": "Resumen", "required": true, "type": "string" },
    { "id": "parent", "name": "Principal", "required": false, "type": "issuelink" },
    { "id": "customfield_10059", "name": "Story Points", "required": false, "type": "number" },
    { "id": "customfield_10064", "name": "Criterios de aceptación", "required": false, "type": "string" },
    { "id": "priority", "name": "Prioridad", "required": false, "type": "priority",
      "allowedValues": ["Highest","High","Medium","Low","Lowest"] }
  ] }
```

**Valor:**
- Es el prerrequisito de `jira_create_issue`: da el contrato real en vez de adivinarlo.
- **Lectura pura** → permite inspeccionar antes de escribir. Relevante porque Jira reserva
  las keys de issue *antes* de validar el payload: un create malformado quema keys de forma
  irreversible (precedente documentado: LAN-1053 → LAN-1061, 2026-04-20).
- Devuelve el `type` real de cada custom field → elimina la duda texto plano vs ADF.
- Es la vía para descubrir los ids de una instancia y anotarlos en la guía del repo.

**Criterio de cierre:** contra un Jira real, listar los tipos de un proyecto y obtener los
campos de al menos dos tipos distintos (uno normal y una subtarea), comprobando que la
subtarea reporta `parent` como requerido.

**Estado: completada y verificada contra el Jira real (2026-07-18).**

##### Corrección de diseño surgida de la verificación

La premisa de que `schema.type` distingue texto plano de ADF **es falsa**. Verificado en LAN:
`summary`, `description` y `customfield_10064` declaran los tres `"type": "string"`.

El discriminador real es **`schema.custom`**:

| Campo | type | custom |
|---|---|---|
| `summary` | `string` | *(sistema)* |
| `description` | `string` | *(sistema)* |
| `customfield_10064` | `string` | `textarea` |
| `customfield_10020` | `array<json>` | `gh-sprint` |

Por eso `JiraFieldSpec` incluye `custom` (solo la variante final del identificador del
plugin, no el `com.atlassian...` completo). Sin ese dato, `jira_create_issue` no puede
serializar correctamente y volvería a caer en el problema que este proyecto quiere eliminar.

##### Datos verificados en el proyecto LAN (2026-07-18)

Contradicen las guías de los repos consumidores. **No cambian el código** — el MCP sigue sin
saber nada de LAN — pero conviene corregir esas guías:

1. **El tipo de defecto se llama `Error`.** Las guías de backend y frontend indican
   `issue_type: "Bug"`; ese tipo no existe en el proyecto. Tipos reales: `Epic`, `Tarea`,
   `Subtarea`, `Historia`, `Error`.
2. **Story Points (`customfield_10059`) no aparece en la pantalla de creación de ningún
   tipo**, tampoco en `Historia`. Las tres guías lo dan por disponible al crear.
3. **Severity (`customfield_10044`) no aparece en la pantalla de creación de `Error`.**
4. **Team (`customfield_10001`) es `required: false` en Jira.** Su obligatoriedad es una
   convención del equipo, no del esquema. El MCP no debe imponerla.
5. **`customfield_10014` (Enlace de epic) solo existe en `Error`**, no en `Historia` ni
   `Tarea` — donde la vía es `parent`.
6. **`customfield_10064` es de tipo `textarea`** (texto rico), no un textarea de texto plano
   como afirman driver y backend. Pendiente de confirmar en escritura si exige ADF.

> Sobre 2 y 3: `createmeta` refleja la **pantalla de creación**. Los campos podrían existir y
> ser editables después; lo verificado es que no se pueden establecer al crear el issue.

#### 2.1 `jira_create_issue`

- Parámetros base: `project`, `issueType`, `summary`, y opcionales `description`, `parent`,
  `assignee`, `priority`, `labels`.
- **`customFields: Record<string, unknown>`** — claves por **nombre o id**, resueltas vía
  `fields.ts`, y serializadas según el `schema.type` real del campo (texto plano vs ADF vs
  option vs number). Aquí es donde el enfoque genérico paga.
- Sin patrones de 2-3 llamadas: hablando REST directo, `description` + `parent` +
  custom fields van en un solo POST. Los errores ADF documentados en las guías son del
  converter del MCP oficial, no de la API.

**Validación previa al POST**, apoyada en el contrato que devuelve `jira_issue_fields`:
comprobar que están los campos requeridos y que los custom fields existen en ese tipo,
**antes** de llamar a la API. Evita quemar keys de issue con payloads malformados.

**Estado: completada y verificada contra el Jira real (2026-07-18).**

##### El error ADF: diagnóstico corregido

Las tres guías atribuyen el error *"El valor de la operación debe ser un documento de
Atlassian"* al converter del MCP oficial, y construyen sobre esa premisa patrones de 2 y 3
llamadas para crear un issue.

**La premisa es falsa.** El error se reproduce hablando REST v3 directo, sin MCP de por medio:

```
PUT /rest/api/3/issue/LAN-1755  { "fields": { "customfield_10064": "[ ] texto plano" } }
→ 400  customfield_10064: El valor de la operación debe ser un documento de Atlassian
```

No es un bug de ninguna herramienta: es la API rechazando texto plano en un campo que exige
ADF. `customfield_10064` es de tipo `textarea` (texto rico), no de texto plano.

**Consecuencia:** el problema nunca fue *combinar* campos, sino el *formato del valor*. Con la
serialización correcta, las tres combinaciones que las guías declaran imposibles funcionan en
una sola llamada. Verificado creando LAN-1756 con `description` + `parent` +
`customfield_10064` + `priority` + `labels` simultáneamente.

Esto elimina de raíz el patrón de 2-3 llamadas: no es una limitación que haya que sortear,
es un diagnóstico equivocado que se propagó por las tres guías.

##### Issues de prueba creados

- **LAN-1755** — `[PRUEBA MCP] Banco de pruebas de jira-lite-mcp`, label `mcp-test`.
  Reutilizable para sondear formatos vía `PUT` sin consumir claves nuevas.
- **LAN-1756** — subtarea de LAN-1755, creada con todos los campos en una llamada.

Ambos en `Finalizada`. Coste total de la verificación: 2 claves.

#### 2.2 `jira_transition_issue`

- Resuelve la transición **por id, por nombre de la transición o por nombre del estado
  destino**, consultando `GET /rest/api/3/issue/{key}/transitions`. Nada de ids hardcodeados:
  son por workflow.
- Si el destino no existe, devuelve las transiciones disponibles en el error — respuesta útil
  para un LLM, que puede reintentar sin intervención.
- Admite comentario opcional.

**Estado: completada y verificada contra el Jira real (2026-07-18).**

##### Por qué se busca también por estado destino

En LAN el nombre de la transición y el del estado al que lleva **no coinciden**: la transición
se llama `Listo` y el estado resultante es `Finalizada`. Quien usa la herramienta piensa en el
estado que quiere («pásalo a Finalizada»), no en cómo se llama la flecha del workflow. Buscar
solo por nombre de transición fallaría en el caso más natural.

##### El comentario va en una llamada aparte, y no por capricho

`POST /issue/{key}/transitions` acepta un comentario en `update.comment`, pero **solo lo
aplica si el workflow define una pantalla que incluya ese campo**. En LAS CUATRO transiciones
de LAN no hay pantalla asociada (`transitions.fields` está vacío), y el resultado es el peor
posible: **la API responde `204` y descarta el comentario sin avisar**.

Verificado: la primera implementación adjuntaba el comentario a la transición, devolvía éxito
y el comentario nunca aparecía en el issue. Ahora se publica con `POST /issue/{key}/comment`,
que funciona con independencia del workflow.

> Nota para las guías del equipo: la regla «transiciona sin comentario y comenta aparte»
> resulta ser **correcta en la práctica**, aunque la razón documentada (error ADF) no lo era.
> En cambio, la recomendación de la guía de frontend de «usar transiciones con comentarios
> para mantener historial claro» **no funciona**: esos comentarios se pierden en silencio.

#### 2.3 `jira_add_comment` y `jira_add_worklog`

- Comentario: texto plano → ADF bien formado.
- Worklog: `timeSpent` en el formato de Jira, **pasado tal cual**. La jornada laboral la
  define la instancia (`GET /rest/api/3/configuration` la expone); no corresponde al MCP
  imponer que `1d` sean 8 o 24 horas.

---

### Fase 3 — A decidir con uso real

#### ✅ `jira_link_issues` — promovida por uso real

Se implementó al comprobar que hacía falta: el **primer ticket real** creado con este MCP
(LAN-1757) necesitaba un enlace `Relates`, y hubo que hacerlo con una llamada directa fuera
de la herramienta. Ese es el criterio para promover algo de esta fase: que el uso lo pida, no
que parezca buena idea.

**Decisión de diseño — la relación se enuncia, no se modela.** La API expone
`inwardIssue`/`outwardIssue`, que obliga a saber en qué extremo va cada issue. La herramienta
acepta la frase tal como se dice —`"blocks"`, `"is blocked by"`, `"relates to"`— y coloca los
extremos por su cuenta: si la relación es la inversa, invierte los issues. El resultado
devuelve cómo quedó realmente el enlace, no cómo se pidió.

Verificado en ambos sentidos: `LAN-1755 blocks LAN-1756` y `LAN-1755 is blocked by LAN-1756`
producen enlaces correctos y opuestos.

#### Pendientes sin compromiso

`jira_update_issue`, paginación avanzada en búsquedas. Se evalúan con el uso.

Cualquier herramienta de flujo compuesto (tipo "empezar trabajo" / "cerrar trabajo") sería
opinada sobre un workflow concreto y **queda fuera del alcance** de un MCP genérico.

---

## 6. Estructura objetivo

```
src/
├── server.ts
├── config/
│   └── env.ts
├── jira/
│   ├── client.ts
│   ├── error.ts
│   ├── adf.ts               ← Fase 0
│   ├── fields.ts            ← Fase 0  (resolución nombre → id + tipo)
│   ├── meta.ts              ← Tarea 1 (tipos de issue y campos por proyecto)
│   ├── issues.ts
│   ├── search.ts
│   ├── users.ts             ← Fase 1
│   ├── my-work.ts           ← Fase 1
│   ├── project-summary.ts   ← Fase 1
│   ├── transitions.ts       ← Fase 2
│   └── worklog.ts           ← Fase 2
├── tools/
│   ├── index.ts
│   ├── ping.ts
│   ├── issue-get.ts
│   ├── search.ts
│   ├── my-work.ts           ← Fase 1
│   ├── project-summary.ts   ← Fase 1
│   ├── explain-issue.ts     ← Fase 1
│   ├── issue-fields.ts      ← Tarea 1
│   ├── create-issue.ts      ← Fase 2
│   ├── transition-issue.ts  ← Fase 2
│   ├── add-comment.ts       ← Fase 2
│   └── add-worklog.ts       ← Fase 2
└── types/
    └── jira.ts
```

Al terminar la Fase 2: **12 herramientas**, ninguna acoplada a una instancia concreta.

---

## 7. Decisiones abiertas

1. **¿`jira_fields` se expone como herramienta MCP o solo como capacidad interna?**
   A favor de exponerla: permite descubrir el id de un campo una vez y anotarlo en la guía del
   repo — que es justo el flujo que se siguió para hallar `customfield_10064`.
   Decisión provisional: exponerla, es barata y habilita el descubrimiento.
2. **Alcance de la resolución por nombre.** ¿Solo custom fields o también estados y tipos de
   issue? El hallazgo sobre JQL (§ siguiente) inclina la balanza hacia extenderlo a los tipos
   de issue.

### Nombres de tipo de issue: traducidos frente a canónicos

Verificado en LAN (2026-07-18). Un sitio traducido devuelve los tipos con su nombre local,
pero **JQL solo acepta el nombre canónico en inglés o el id**:

| Nombre mostrado | Válido en JQL | id |
|---|---|---|
| Epic | `Epic` | 10000 |
| Tarea | `Task` | 10007 |
| Subtarea | `"Sub-task"` | 10008 |
| Historia | `Story` | 10009 |
| Error | `Bug` | 10010 |

Lo peligroso es el modo de fallo: `issuetype = Error` **no da error, devuelve cero
resultados**. Una búsqueda equivocada parece una búsqueda vacía.

En cambio, al **crear** un issue el nombre traducido sí funciona (`issuetype: {name:
"Subtarea"}` creó LAN-1756). La divergencia afecta solo a JQL.

Implicación para el MCP: cuando una herramienta construya JQL a partir de un tipo de issue
—`jira_project_summary` al contar bugs, por ejemplo— debe traducir el nombre al canónico o
usar el id, resolviéndolo contra la instancia. Nunca interpolar el nombre recibido.
3. **Paginación.** Derivar `total` del resultado o implementar `nextPageToken` completo.
   Depende de si algún flujo necesita más de 100 resultados.

---

## 8. Criterios de calidad por paso

- [ ] `npm run build` sin errores.
- [ ] La tool aparece y responde en MCP Inspector.
- [ ] Verificada contra un Jira real, no solo compilando.
- [ ] La respuesta es legible para un LLM: sin ruido, sin objetos crudos de Jira.
- [ ] **Nada específico de una instancia en el código** (proyectos, estados, ids de campo,
      ids de transición, workflows).
- [ ] Sin duplicación: las tools nuevas reutilizan la capa `jira/` existente.
- [ ] La responsabilidad del archivo es evidente por su nombre.
```

