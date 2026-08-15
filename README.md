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

> Tras cambiar el código hay que ejecutar `npm run build` **y reiniciar la sesión**: el
> cliente arranca el servidor al abrirla y mantiene ese proceso mientras dura, así que hasta
> entonces sigue sirviendo el código anterior. `/clear` no basta.
>
> La herramienta `ping` indica qué código está en ejecución:
>
> ```json
> { "status": "ok", "version": "1.1.0", "built": "2026-07-20T02:16:44.020Z" }
> ```
>
> Si `built` es anterior a la última compilación, la sesión está sirviendo código antiguo.
> Es la forma de distinguir una capacidad que no existe de una que no está desplegada.

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
| `jira_list_projects` | Proyectos visibles, con su clave. *«¿Qué proyectos hay?»* |
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
| `jira_create_sprint` | Crear un sprint en el tablero scrum del proyecto |
| `jira_move_to_sprint` | Mover issues a un sprint |
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

**Campos obligatorios por convención.** Un equipo puede dar por obligatorio un campo que
Jira no marca como tal —y cuya ausencia, por tanto, no señala—. `JIRA_REQUIRED_FIELDS` lo
convierte en un error al crear:

```
JIRA_REQUIRED_FIELDS_LAN=Team     # solo en el proyecto LAN
JIRA_REQUIRED_FIELDS=Team         # en todos
```

No se rellena nada automáticamente: la creación se rechaza para que el valor lo decida
siempre quien la pide. Con `dryRun` la comprobación se hace igualmente, sin gastar una clave.

En una subtarea el requisito se comprueba **contra su issue padre**, porque hereda de él parte
del contexto. Algunos campos —el equipo asignado, por ejemplo— Jira ni siquiera admite
enviarlos en una subtarea: los rechaza indicando que se heredan. Exigirlos en el payload
haría imposible crear subtareas en un proyecto con esta política.

**No se pueden eliminar issues.** `jira_delete` cubre comentarios, registros de tiempo y
enlaces, pero no issues: borrar uno destruye trabajo registrado junto con sus subtareas y deja
un hueco permanente en la numeración del proyecto. Para retirar un issue de la circulación,
moverlo a un estado final con `jira_transition_issue`.

**Los sprints cuelgan del tablero, no del proyecto.** Y solo los tableros scrum los admiten:
en un proyecto kanban no hay dónde crearlos. `jira_create_sprint` acepta la clave del proyecto
y localiza su tablero scrum; si hay más de uno, el error los enumera con su `boardId` en vez de
elegir por su cuenta.

**Crear un sprint no lo arranca.** Queda en estado `future`. Iniciarlo cierra el anterior y fija
el compromiso del equipo, así que esa decisión se deja en Jira.

```json
{ "project": "LAN", "name": "Sprint 12", "startDate": "2026-09-01", "endDate": "2026-09-15" }
```

Una fecha sin hora se ancla a medianoche UTC: Jira solo muestra el día, y anclarla a la hora
local la desplazaría al día anterior para quien esté al oeste del meridiano.

**Un issue pertenece a un solo sprint.** `jira_move_to_sprint` lo saca del anterior, así que
sirve igual para poblar un sprint nuevo que para reubicar trabajo. La API mueve como mucho 50
issues por petición y aplica cada una entera o ninguna: con más de 50 la respuesta indica
cuáles se movieron y qué lote falló, en lugar de dar por hecho que se movió todo.

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
