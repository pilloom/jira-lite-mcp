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

`--scope user` lo deja disponible en todos los proyectos, con las credenciales en el `.env` de
este repositorio.

Comprobar que responde:

```bash
claude mcp get jira-lite
```

> Tras cambiar el código hay que ejecutar `npm run build`: el servidor arranca desde `dist/`.

### Registrar en un proyecto concreto (`.mcp.json`)

Para dejarlo declarado en un repositorio y compartirlo con el equipo, se usa el scope
`project`, que escribe un `.mcp.json` en su raíz:

```bash
claude mcp add --scope project jira-lite -- node /ruta/absoluta/a/jira-lite-mcp/dist/server.js
```

El fichero resultante se commitea. Como cada persona clonará este servidor en una ubicación
distinta, la ruta absoluta conviene sustituirla por una variable con valor por defecto:

```json
{
  "mcpServers": {
    "jira-lite": {
      "command": "node",
      "args": ["${JIRA_MCP_PATH:-/ruta/por/defecto}/jira-lite-mcp/dist/server.js"]
    }
  }
}
```

Cada miembro define `JIRA_MCP_PATH` en su shell y mantiene su propio `.env` en este
repositorio. No hace falta declarar las credenciales en `.mcp.json`.

Si se prefiere pasarlas desde el cliente, se añaden como variables del servidor:

```json
"env": {
  "JIRA_URL": "${JIRA_URL}",
  "JIRA_EMAIL": "${JIRA_EMAIL}",
  "JIRA_TOKEN": "${JIRA_TOKEN}"
}
```

> ⚠️ Nunca escribir el token literal: `.mcp.json` se versiona.
>
> Un cliente que no encuentre la variable **entrega el marcador sin sustituir** en lugar de
> omitirlo. El servidor detecta ese caso y recurre al `.env`, en vez de intentar autenticarse
> con la cadena `${JIRA_TOKEN}` y devolver un error de credenciales sin relación aparente.

La primera vez que alguien abra el proyecto, Claude Code pedirá aprobar los servidores
declarados. `claude mcp reset-project-choices` restablece esa decisión.

Un servidor con el mismo nombre en varios ámbitos se resuelve por precedencia —local, luego
proyecto, luego usuario— y se usa la definición completa del que gane, sin combinar campos.

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
| `jira_get_worklog` | Tiempo registrado en un issue: estimación, total y desglose |

### Escritura

| Herramienta | Para qué |
|---|---|
| `jira_create_issue` | Crear un issue, validando los campos antes de enviarlos |
| `jira_update_issue` | Modificar campos de un issue |
| `jira_transition_issue` | Cambiar de estado, opcionalmente con comentario |
| `jira_link_issues` | Enlazar dos issues |
| `jira_add_comment` | Comentar |
| `jira_add_worklog` | Registrar tiempo |
| `jira_delete` | Eliminar un comentario, un registro de tiempo o un enlace |

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

**No se pueden eliminar issues.** `jira_delete` cubre comentarios, registros de tiempo y
enlaces, pero no issues: borrar uno destruye trabajo registrado junto con sus subtareas y deja
un hueco permanente en la numeración del proyecto. Para retirar un issue de la circulación,
moverlo a un estado final con `jira_transition_issue`.

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
