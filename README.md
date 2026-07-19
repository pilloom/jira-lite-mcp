# jira-lite-mcp

Servidor MCP para Jira Cloud, pensado para trabajar con Claude Code.

No pretende cubrir toda la API de Jira: expone pocas herramientas de alto valor, con
respuestas legibles para un modelo en lugar de las respuestas crudas de la API.

**Es genérico.** No conoce proyectos, épicas ni campos personalizados concretos: los resuelve
contra la instancia a la que se conecta. Los nombres de campo se indican como se ven
(`"Criterios de aceptación"`) y el servidor los traduce a su identificador real.

---

## Requisitos

- Node 20 o superior
- Una cuenta de Jira Cloud con [token de API](https://id.atlassian.com/manage-profile/security/api-tokens)

---

## Instalación

```bash
npm install
cp .env.example .env   # y rellenar
npm run build
```

`.env`:

```
JIRA_URL=https://tu-organizacion.atlassian.net
JIRA_EMAIL=tu-correo@example.com
JIRA_TOKEN=tu-token
```

### Registrar en Claude Code

```bash
claude mcp add jira-lite --scope user -- node /ruta/absoluta/a/jira-lite-mcp/dist/server.js
```

`--scope user` lo deja disponible en todos los proyectos. Para limitarlo a un repositorio
concreto, `--scope project` genera un `.mcp.json` que puede compartirse con el equipo; en ese
caso conviene pasar las credenciales por `--env` en lugar de usar el `.env` local.

Comprobar que responde:

```bash
claude mcp get jira-lite
```

> Tras cambiar el código hay que ejecutar `npm run build`: el servidor arranca desde `dist/`.

---

## Herramientas

### Lectura

| Herramienta | Para qué |
|---|---|
| `jira_my_work` | Issues asignados y pendientes. *«¿Qué tengo pendiente en Jira?»* |
| `jira_project_summary` | Estado de un proyecto: abiertos, reparto por estado, tipo y prioridad, sin asignar y estancados |
| `jira_explain_issue` | Un issue con todo su contexto: padre, subtareas, enlaces, comentarios y transiciones posibles |
| `jira_get_issue` | Datos básicos de un issue |
| `jira_search` | Búsqueda por JQL |
| `jira_issue_fields` | Tipos de issue de un proyecto y campos que admite cada uno al crearlo |

### Escritura

| Herramienta | Para qué |
|---|---|
| `jira_create_issue` | Crear un issue, validando los campos antes de enviarlos |
| `jira_update_issue` | Modificar campos de un issue |
| `jira_transition_issue` | Cambiar de estado, opcionalmente con comentario |
| `jira_link_issues` | Enlazar dos issues |
| `jira_add_comment` | Comentar |
| `jira_add_worklog` | Registrar tiempo |

---

## Notas de uso

**Los campos se indican por su nombre.** `jira_create_issue` y `jira_update_issue` aceptan
`customFields` con el nombre visible del campo, y el servidor resuelve el identificador y el
formato correctos contra la instancia:

```json
{ "customFields": { "Criterios de aceptación": "[ ] Primero\n[ ] Segundo" } }
```

**Se valida antes de escribir.** Al crear un issue se comprueban los campos contra el esquema
real del proyecto y del tipo. Un payload incorrecto falla en local, sin llegar a la API: Jira
reserva la clave del issue al procesar la petición, y una petición inválida la consume igual.

**Los estados se indican por su nombre.** `jira_transition_issue` acepta el estado de destino
(`"Finalizada"`), el nombre de la transición (`"Listo"`) o su identificador, y resuelve cuál
aplica contra el workflow del issue.

**En JQL los tipos de issue van en inglés.** Un sitio traducido muestra `Historia` o `Error`,
pero `jira_search` necesita `Story` o `Bug`: escribir el nombre traducido devuelve cero
resultados sin dar error. `jira_project_summary` no se ve afectado, porque agrupa por tipo
sobre los issues ya recuperados.

**Las búsquedas no devuelven el total de coincidencias.** El endpoint de Jira pagina y no
informa del total, así que `jira_search` devuelve cuántos issues trae (`count`) y si quedan más
(`hasMore`).

---

## Desarrollo

```bash
npm run dev     # servidor en modo watch
npm run build   # compilar a dist/
```

Inspeccionar el servidor sin pasar por Claude Code:

```bash
npx @modelcontextprotocol/inspector --cli node dist/server.js --method tools/list
npx @modelcontextprotocol/inspector --cli node dist/server.js \
  --method tools/call --tool-name jira_my_work --tool-arg limit=5
```

La arquitectura y las decisiones de diseño están en [`docs/plan/PLAN.md`](docs/plan/PLAN.md).
