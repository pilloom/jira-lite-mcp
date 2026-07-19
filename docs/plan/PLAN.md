# Plan de trabajo — jira-lite-mcp

> Documento vivo.
> Última actualización: 2026-07-18

---

## 1. Tesis del proyecto

`jira-lite-mcp` es un servidor MCP **genérico para cualquier Jira Cloud**, orientado a
productividad con Claude Code.

No conoce proyectos, ni épicas, ni custom fields concretos. Nada específico de una instancia
se hornea en el código: eso vive en la guía de cada repo que lo consume.

Lo que aporta frente al MCP oficial de Atlassian:

1. **Pocas herramientas de alto valor** en vez de decenas de wrappers 1:1 de la API.
2. **Respuestas optimizadas para LLM**: sin `self`, `avatarUrls`, `iconUrl` ni el resto del
   ruido que Jira devuelve por defecto.
3. **Campos por nombre, no por id**: se escribe `"Criterios de aceptación"` y el servidor
   resuelve `customfield_10064` contra *esa* instancia.
4. **Validación antes de escribir**: un payload inválido falla en local, sin consumir claves
   de issue ni descartarse en silencio.
5. **Normalización de los formatos raros de Jira**: ADF, nombres traducidos, paginación.

**Regla de diseño:** si una decisión requiere saber cómo se llama un proyecto, un estado o un
campo en una instancia concreta, esa decisión **no pertenece al código**. Pertenece a un
parámetro o a la guía del repo consumidor.

---

## 2. Estado actual

**13 herramientas.** Compila en verde; todas verificadas contra un Jira real.
**Todo lo previsto en el plan está implementado.**

| Herramienta | Estado | Módulo `jira/` |
|---|---|---|
| `ping` | ✅ | — |
| `jira_get_issue` | ✅ | `issues.ts`, `adf.ts` |
| `jira_search` | ✅ | `search.ts`, `adf.ts` |
| `jira_issue_fields` | ✅ | `meta.ts` |
| `jira_create_issue` | ✅ | `create.ts`, `fields.ts`, `adf.ts` |
| `jira_transition_issue` | ✅ | `transitions.ts` |
| `jira_link_issues` | ✅ | `links.ts` |
| `jira_update_issue` | ✅ | `update.ts` |
| `jira_my_work` | ✅ | `my-work.ts`, `users.ts` |
| `jira_project_summary` | ✅ | `project-summary.ts` |
| `jira_explain_issue` | ✅ | `explain.ts` |
| `jira_add_comment` | ✅ | `comments.ts` |
| `jira_add_worklog` | ✅ | `worklog.ts` |

**Pendiente:** nada del plan original. Lo siguiente sale de pulir con uso real.

> ✅ **Verificado en MCP Inspector (2026-07-18).** Pasada completa con
> `npx @modelcontextprotocol/inspector --cli node dist/server.js`. Las 8 herramientas se
> registran, exponen sus esquemas JSON con los parámetros correctos, responden a `tools/call`
> y propagan los errores como `isError: true` con un mensaje legible.
>
> Dos cosas que solo se ven a través del protocolo: el paso de `z.object({...})` como
> `inputSchema` **funciona** con este SDK (había dudas de si el SDK esperaba un `ZodRawShape`),
> y la deuda §5 se manifiesta con toda su gravedad — ver la nota de esa sección.

---

## 3. Qué aportó el análisis de las guías

Las tres `JIRA_GUIDE.md` analizadas (proyecto LAN) no definen el diseño, pero sí revelan
**qué campos se usan de verdad** y por tanto qué debe devolver una respuesta útil:

- **Lectura habitual:** key, summary, status, priority, assignee, updated, issuetype, parent,
  labels, estimación, criterios de aceptación (custom), subtareas, enlaces.
- **Ignorable siempre:** avatares, urls internas, `self`, ids redundantes, metadatos de
  renderizado.
- **Escritura habitual:** crear issue con parent + custom fields, transicionar, comentar,
  registrar worklog, enlazar issues.
- **Formatos que muerden:** ADF en `description`, comentarios y custom fields de texto rico;
  nombres traducidos que no valen en JQL; unidades de tiempo según la jornada del sitio.

El corolario que ordena todo el diseño: **el formato de un campo no se adivina, se consulta**.
Y no basta con `schema.type` (ver §7.1): el discriminador es `schema.custom`.

---

## 4. Principios de arquitectura (confirmados)

- `tools/` **solo** traduce MCP ↔ dominio. Cero HTTP, cero lógica Jira.
- `jira/` **solo** habla con Jira. Cero conocimiento de MCP.
- `types/jira.ts` define contratos propios; nunca se filtra un objeto crudo de Jira.
- Errores siempre vía `jira/error.ts`.
- TypeScript strict, ESM, imports con `.js`.
- `npm run build` verde antes de cerrar cualquier paso.

Configuración: **solo** `JIRA_URL`, `JIRA_EMAIL`, `JIRA_TOKEN`.

---

## 5. Deuda técnica

| # | Deuda | Estado |
|---|---|---|
| 1 | `issues.ts` y `search.ts` tipaban `description` como `string`, pero la API v3 devuelve **ADF**. | ✅ resuelta |
| 2 | `search.ts` leía un `total` que `POST /search/jql` **ya no devuelve**. | ✅ resuelta |
| 3 | `adf.ts` no implementaba `adfToText`. | ✅ resuelta |
| 4 | `createJiraClient()` se instancia en cada llamada. Funciona; **no se toca** sin motivo real. | ⏸️ deliberado |

### Resolución (2026-07-18)

`adfToText` aplana el documento a texto legible y tolera lo que le llegue: un string —los
campos de texto plano vienen así—, `null` o un documento completo. Cubre además nodos que
`textToAdf` nunca genera pero que Jira sí devuelve: listas, encabezados, menciones, emoji,
bloques de código y separadores.

**Round-trip exacto verificado** para `textToAdf` → `adfToText`, incluidos acentos, saltos
múltiples y símbolos (`{a+b}`, `[ ]`, `@`).

**El `total` se sustituye por `count` + `hasMore`.** El endpoint nuevo no devuelve el total de
coincidencias: pagina con `nextPageToken`. Informar de cuántos se devuelven y de si quedan más
es honesto; inventar un total que la API ya no da, no. `jira_search` acepta ahora `limit`, que
es lo que hace accionable el `hasMore`.

> Si `jira_project_summary` necesita totales reales, la vía es
> `POST /rest/api/3/search/approximate-count`, una llamada aparte. Se añadirá si ese caso lo
> pide, no antes.

Verificado a través del protocolo MCP: la descripción de LAN-1757 llega como texto plano
legible, y una búsqueda con `limit=5` sobre el proyecto devuelve `count: 5, hasMore: true`.

---

## 6. Orden de ejecución

Las fases describen el **alcance**, no el orden. El orden lo marcó el primer flujo real que el
proyecto debía soportar: crear un issue de cualquier tipo con los campos que le corresponden.

| # | Tarea | Fase | Estado |
|---|---|---|---|
| 1 | `jira_issue_fields` | 2 | ✅ |
| 2 | `jira_create_issue` | 2 | ✅ |
| 3 | `textToAdf` (parte de `adf.ts`) | 0 | ✅ |
| 4 | `jira_transition_issue` | 2 | ✅ |
| 5 | `jira_link_issues` | 3 | ✅ promovida por uso real |
| 6 | `jira_update_issue` | 3 | ✅ promovida por uso real |
| 7 | **Deuda §5: `adfToText` + `search.ts` + `issues.ts`** | 0 | ✅ |
| 8 | `jira_my_work` | 1 | ✅ |
| 9 | `jira_project_summary`, `jira_explain_issue` | 1 | ✅ |
| 10 | `jira_add_comment`, `jira_add_worklog` | 2 | ✅ |

**Criterio para promover algo de la fase 3:** que el uso lo pida, no que parezca buena idea.
Las tareas 5 y 6 se implementaron porque un ticket real las necesitó.

---

## 7. Hallazgos verificados contra Jira (2026-07-18)

Todos reproducidos contra la REST API v3. **Ninguno cambia el diseño genérico**, pero varios
corrigieron implementaciones o creencias equivocadas.

### 7.1 `schema.type` no distingue texto plano de ADF

La premisa inicial era falsa. `summary`, `description` y `customfield_10064` declaran los tres
`"type": "string"`. El discriminador real es **`schema.custom`**:

| Campo | type | custom |
|---|---|---|
| `summary` | `string` | *(sistema — texto plano)* |
| `description` | `string` | *(sistema — exige ADF)* |
| `customfield_10064` | `string` | `textarea` *(exige ADF)* |
| `customfield_10020` | `array<json>` | `gh-sprint` |

Por eso `JiraFieldSpec` incluye `custom`. Sin ese dato, la serialización sería adivinanza.

### 7.2 El error ADF: diagnóstico corregido

Las tres guías del equipo atribuyen *"El valor de la operación debe ser un documento de
Atlassian"* al converter del MCP oficial, y construyen patrones de 2-3 llamadas sobre esa
premisa. **Es falsa.** Reproducido sin MCP de por medio:

```
PUT /rest/api/3/issue/LAN-1755  { "fields": { "customfield_10064": "[ ] texto plano" } }
→ 400  El valor de la operación debe ser un documento de Atlassian
```

Lo mismo ocurre con `description`. Es la API rechazando texto plano en campos de texto rico.

**El problema nunca fue combinar campos, sino el formato del valor.** Con serialización
correcta, las combinaciones «imposibles» funcionan en una llamada. Verificado dos veces:

- **Creando** LAN-1756 con `description` + `parent` + `customfield_10064` + `priority` +
  `labels` simultáneamente.
- **Actualizando** LAN-1757 con `description` + `customfield_10064` a la vez — literalmente la
  regla nº1 de la guía de driver.

### 7.3 Nombres de tipo: traducidos frente a canónicos

Un sitio traducido devuelve los tipos con su nombre local, pero **JQL solo acepta el canónico
en inglés o el id**:

| Nombre mostrado | Válido en JQL | id |
|---|---|---|
| Epic | `Epic` | 10000 |
| Tarea | `Task` | 10007 |
| Subtarea | `"Sub-task"` | 10008 |
| Historia | `Story` | 10009 |
| Error | `Bug` | 10010 |

El modo de fallo es el peligroso: `issuetype = Error` **no da error, devuelve cero
resultados**. Una búsqueda equivocada es indistinguible de una vacía.

Al **crear**, en cambio, el nombre traducido sí funciona. La divergencia afecta solo a JQL.

> **Implicación pendiente:** cuando `jira_project_summary` construya JQL a partir de un tipo,
> debe traducirlo al canónico o usar el id. **Nunca interpolar el nombre recibido.**

### 7.4 Jira descarta en silencio lo que no está en pantalla

Patrón que apareció tres veces y que justifica toda la validación previa:

- **Transiciones:** `update.comment` solo se aplica si el workflow define una pantalla con ese
  campo. En LAN ninguna de las cuatro la tiene → la API responde **`204` y descarta el
  comentario**. La primera implementación devolvía éxito con el comentario en el vacío.
- **Creación:** el tipo `Error` no exponía `customfield_10064`. La validación previa lo
  detuvo en local, **antes** de consumir una clave.
- **Edición:** `editmeta` y `createmeta` no son el mismo conjunto de campos.

De ahí que `create.ts` valide contra `createmeta` y `update.ts` contra `editmeta`, y que el
comentario de una transición se publique con `POST /issue/{key}/comment`.

### 7.5 Datos del proyecto LAN

Ya trasladados a las tres guías del equipo:

1. El tipo de defecto se llama **`Error`**; `Bug` no existe al crear (pero sí en JQL).
2. **Story Points** (`customfield_10059`, `float`) y **Severity** (`customfield_10044`,
   `select`) existen en el sitio pero **no están en ninguna pantalla de LAN**, ni de creación
   ni de edición.
3. **Team** (`customfield_10001`) es `required: false`. Su obligatoriedad es convención del
   equipo, no del esquema.
4. `customfield_10014` (Enlace de epic) solo aparece en el tipo `Error`.
5. Épicas: `LAN-225` driver · `LAN-246` frontend · `LAN-1` backend.
6. Teams: `Driver App` `fbad06c2-…` · `Client App` `b6d33f51-…` · `Frontend` `4a5407f1-…` ·
   `Backend` `7d62bf4c-…`.
7. **`customfield_10064` no estaba en las pantallas del tipo `Error`.** Corregido en la
   configuración de Jira por el equipo el 2026-07-18; `jira_create_issue` lo admite desde
   entonces **sin cambios en el código**, por consultar `createmeta` en cada llamada.

### 7.6 Issues creados

| Issue | Qué es | Estado |
|---|---|---|
| LAN-1755 | `[PRUEBA MCP]` banco de pruebas, label `mcp-test` | Finalizada |
| LAN-1756 | `[PRUEBA MCP]` subtarea con todos los campos en una llamada | Finalizada |
| LAN-1757 | **Ticket real**: bug de E11000 al reemplazar foto de perfil | En curso |

Coste total: 3 claves, ninguna quemada.

---

## 8. Fases pendientes

### Fase 0 — Cimientos (deuda §5) ⏭️ siguiente

- `adf.ts`: añadir `adfToText(doc)` — aplana ADF a texto legible; tolerante con strings.
- `issues.ts` y `search.ts`: pasar `description` por `adfToText`.
- `search.ts`: dejar de leer el `total` inexistente; paginación honesta con `nextPageToken`.

**Cierre:** `jira_get_issue` devuelve descripciones legibles y `jira_search` un `total` real.

### Fase 1 — Lectura inteligente

#### ✅ `jira_my_work`

- `users.ts` — `getCurrentUser()` vía `GET /rest/api/3/myself`.
- `my-work.ts` — construye el JQL y reutiliza la ejecución de búsqueda.

JQL base: `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`

> Se filtra por **`statusCategory`**, no por `status != Done`: la categoría es invariante de
> Jira, el nombre del estado depende del workflow y del idioma. En LAN el estado final se
> llama `Finalizada`, y `status != Done` no habría filtrado nada. **Verificado**: por defecto
> no aparece ningún `Finalizada`; con `includeDone: true` sí.

**Reutilización sin acoplar contratos.** `my_work` necesita `priority` e `updated`, que la
búsqueda no pedía. En vez de duplicar el fetch o hinchar `JiraIssue` con campos que solo usa
una herramienta, se extrajo `runJql(jql, fields, limit)` en `search.ts`: devuelve los issues
sin interpretar y cada herramienta pide sus campos y los traduce a su propio contrato.

`updated` se recorta a la fecha, sin hora ni zona horaria: basta para situar el issue y ahorra
ruido.

Parámetros opcionales: `project`, `limit`, `includeDone`. Sin `project` busca en **todos** los
proyectos del sitio — verificado con issues de `LAN` e `IB` en la misma respuesta.

#### ✅ `jira_project_summary`

Abiertos, reparto por estado, tipo y prioridad, sin asignar y estancados. Sin heurísticas de
«riesgo»: hechos, y que Claude interprete.

**Cómo se esquivó el problema de §7.3.** El JQL filtra solo por proyecto y `statusCategory`;
el reparto por tipo se cuenta **en nuestra capa** a partir del `issuetype` de cada issue. Al no
interpolar nunca un nombre de tipo en la consulta, el fallo silencioso de los nombres
traducidos no puede darse.

**Agrega sobre el conjunto completo, no sobre una página.** `runJqlAll` recorre las páginas
con `nextPageToken` hasta un tope de 1000 issues; si se alcanza, lo declara con `truncated`
en lugar de presentar un recuento parcial como si fuera total.

Verificado en LAN: 207 abiertos en 3 páginas, sin truncar.

#### ✅ `jira_explain_issue`

El issue **con su contexto en dos llamadas paralelas**: descripción en texto plano, padre,
subtareas, enlaces, comentarios recientes, transiciones disponibles y los campos que se pidan
por nombre. No genera prosa — entrega material limpio para que Claude explique.

**Aquí apareció el caso de uso del catálogo global de campos.** Al leer un issue no hay
pantalla que acote los campos disponibles, así que `extraFields` se resuelve contra
`GET /rest/api/3/field`, cacheado por proceso. Es lo que el plan original preveía para
`fields.ts` y que hasta ahora no había hecho falta.

**Enlaces deduplicados.** Jira admite enlazar el mismo par de issues en ambos sentidos; con
una relación simétrica como «relates to» eso produce dos entradas idénticas. Ocurrió de verdad
entre LAN-1757 y LAN-1754, así que se colapsan por relación y clave.

### Fase 2 — Escritura restante

#### ✅ `jira_add_comment` y `jira_add_worklog`

El comentario se extrajo a `comments.ts` y `transitions.ts` pasa a usarlo, en lugar de
mantener dos caminos hacia el mismo endpoint.

`timeSpent` se envía **tal cual**. La respuesta incluye `timeSpentSeconds`, que es cómo lo ha
interpretado Jira: quien llama puede comprobar el resultado en vez de fiarse de una conversión
hecha por este servidor.

`started` acepta una fecha ISO y la traduce al formato del endpoint, que rechaza la forma
terminada en `Z` y exige el desfase sin dos puntos. Una fecha no reconocible falla con un
mensaje explícito antes de llamar a la API.

##### El `1d` triplicado: resuelto

Las guías del equipo advierten de que `1d` se registra como 24 h y Jira lo muestra como `3d`.
Verificado contra la API directa en LAN-1755:

| Enviado | Guardado | Jira muestra |
|---|---|---|
| `8h` | 28800 s (8 h) | `1d` |
| `1d` | 28800 s (8 h) | `1d` |

**La jornada del sitio son 8 horas y `1d` se interpreta correctamente.** El ×3 lo producía el
MCP oficial, que convertía `1d` a 86400 s antes de enviarlo; Jira recibía 24 h y las mostraba
como `3d`. Las guías lo atribuían al parser de esa herramienta, y acertaban. Con este servidor
la restricción no aplica.

### Fase 3 — Sin compromiso

Paginación avanzada en búsquedas. Se evalúa con el uso.

Las herramientas de flujo compuesto («empezar trabajo», «cerrar trabajo») serían opinadas
sobre un workflow concreto y **quedan fuera del alcance** de un MCP genérico.

---

## 9. Estructura actual

```
src/
├── server.ts
├── config/
│   └── env.ts
├── jira/
│   ├── client.ts
│   ├── error.ts
│   ├── names.ts             ✅ normalización de nombres (idioma/acentos)
│   ├── adf.ts               ✅ textToAdf + adfToText
│   ├── fields.ts            ✅ resolución por nombre + serialización por tipo
│   ├── meta.ts              ✅ createmeta + editmeta
│   ├── create.ts            ✅
│   ├── update.ts            ✅
│   ├── transitions.ts       ✅
│   ├── links.ts             ✅
│   ├── issues.ts            ✅
│   ├── search.ts            ✅
│   ├── users.ts             ⏳ fase 1
│   ├── my-work.ts           ⏳ fase 1
│   ├── project-summary.ts   ⏳ fase 1
│   └── worklog.ts           ⏳ fase 2
├── tools/
│   ├── index.ts
│   ├── ping.ts              ✅
│   ├── issue-get.ts         ✅
│   ├── search.ts            ✅
│   ├── issue-fields.ts      ✅
│   ├── create-issue.ts      ✅
│   ├── update-issue.ts      ✅
│   ├── transition-issue.ts  ✅
│   ├── link-issues.ts       ✅
│   ├── my-work.ts           ⏳ fase 1
│   ├── project-summary.ts   ⏳ fase 1
│   ├── explain-issue.ts     ⏳ fase 1
│   ├── add-comment.ts       ⏳ fase 2
│   └── add-worklog.ts       ⏳ fase 2
└── types/
    └── jira.ts
```

Al completar lo previsto: **13 herramientas**, ninguna acoplada a una instancia concreta.

> Nota sobre `fields.ts`: el plan original lo describía como un catálogo global cacheado sobre
> `GET /rest/api/3/field`. **No hizo falta.** `meta.ts` (createmeta/editmeta) da los campos por
> contexto, que es más preciso, así que `fields.ts` acabó siendo resolución por nombre y
> serialización por tipo sobre esos specs. El catálogo global sigue sin implementarse porque
> ningún caso de uso lo ha pedido todavía.

---

## 10. Decisiones abiertas

1. **Resolución de nombres de tipo de issue para JQL.** §7.3 la hace necesaria en cuanto una
   herramienta construya JQL por tipo. Pendiente de decidir si se resuelve vía `/issuetype` o
   pasando el id.
2. ~~**Paginación.**~~ ✅ Resuelta: `count` + `hasMore` en lugar de un `total` que la API ya no
   da (§5). La paginación completa con `nextPageToken` queda pendiente de que algún flujo
   necesite recorrer más de una página.
3. ~~**Verificación en MCP Inspector.**~~ ✅ Resuelta: pasada completa el 2026-07-18 (§2). La
   vía es `--cli`, que no necesita navegador y sirve tanto para `tools/list` como para
   `tools/call`. Queda como comprobación de cierre de cada fase, no de cada tarea.

---

## 11. Criterios de calidad por paso

- [ ] `npm run build` sin errores.
- [ ] Verificada contra un Jira real, no solo compilando.
- [ ] La tool aparece y responde en MCP Inspector. *(Pasada completa el 2026-07-18 — §2.)*
- [ ] La respuesta es legible para un LLM: sin ruido, sin objetos crudos de Jira.
- [ ] **Nada específico de una instancia en el código** (proyectos, estados, ids de campo,
      ids de transición, workflows).
- [ ] Sin duplicación: las tools nuevas reutilizan la capa `jira/` existente.
- [ ] La responsabilidad del archivo es evidente por su nombre.
