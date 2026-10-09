# Changelog

Cambios que afectan a quien usa el servidor. Las versiones anteriores a la 1.2.0
se reconstruyen del historial: hasta entonces no había este fichero.

Tras actualizar hay que ejecutar `npm run build` —que vacía `dist/` antes de
compilar— **y reiniciar la sesión de Claude
Code**: el cliente arranca el servidor al abrirla y mantiene ese proceso mientras
dura. `ping` dice si el proceso que atiende la sesión ha cargado el código que hay
compilado, o si quedó por detrás.

---

## 1.5.0 — 2026-10-09

Dos correcciones sobre los campos que se piden por `fields`, salidas de usarlo
en una instancia en español el día que se publicó.

### La clave de la respuesta es el nombre que se pidió

Era el nombre canónico del campo en la instancia, que en un sitio en español
está traducido. Así que pedir `["priority", "labels", "updated", "parent"]`
devolvía `Prioridad`, `Etiquetas`, `Actualizada` y `Principal`, y quien leyera
`customFields.priority` encontraba `undefined` —indistinguible de un campo
vacío, que es el fallo que el resto de esta versión existe para no cometer—.

```json
{ "fields": ["priority"] }   →   { "customFields": { "priority": … } }
```

Pedir por identificador devuelve el identificador como clave, y pedir por
nombre lo devuelve tal como se escribió, acentos y mayúsculas incluidos. La
clave ya no depende del idioma del sitio.

### Un issue referenciado se devuelve como lo que lo identifica

`fields: ["parent"]` devolvía la épica entera anidada: estado, prioridad, tipo,
cada uno con su `self` y su `iconUrl`. Venía del criterio de no descartar lo que
no se sabe formatear, pero un issue sí se sabe: es lo que los campos nativos del
contrato ya devuelven.

```json
{ "customFields": { "parent": { "key": "LAN-2739", "summary": "…" } } }
```

Aplica igual a cualquier campo que contenga issues, y a las listas de ellos.

---

## 1.4.0 — 2026-10-09

Las tres lecturas piden los campos personalizados con el mismo parámetro, y la
búsqueda deja de descartar en silencio el que se le pasaba.

### `jira_search` acepta `fields`

Admitía el parámetro sin declararlo, así que el validador lo descartaba y la
búsqueda respondía sin error y sin el campo pedido. Ahora lo devuelve, en un
`customFields` por issue, por nombre visible o por identificador:

```json
{ "jql": "project = LAN AND status != Done", "fields": ["Criterios de aceptación"] }
```

Un campo que no se puede resolver en un issue concreto **no interrumpe la
búsqueda**: se informa en `warning`, agrupado por campo y nombrando los issues
afectados, y el resto de resultados se devuelve igual. En una búsqueda que
cruza varios proyectos, un issue de un proyecto sin ese campo es lo normal, y
tumbar la página entera por él sería peor que informar.

### El parámetro se llama `fields` en las tres

`jira_explain_issue` lo llamaba `extraFields` y `jira_get_issue` `fields`, para
lo mismo. El nombre vigente es `fields`. `extraFields` se sigue aceptando y
funcionando, pero la respuesta trae un `warning` que avisa del cambio: hacerlo
fallar rompería llamadas que hoy funcionan, y aceptarlo en silencio dejaría la
incoherencia para siempre. Si llegan los dos, se usa `fields` y se dice.

### El servidor deja de escribir en el canal del protocolo

`dotenv` anunciaba en la salida estándar las variables que cargaba. En un
servidor MCP esa salida es el canal JSON-RPC, así que el cliente tiene que
descartar esa línea para seguir hablando; uno estricto se rompe. Descubierto al
probar los cambios de esta versión con un cliente propio, que se rompió ahí.

### Un parámetro que no existe da error en vez de descartarse

Las herramientas declaraban sus argumentos sin cerrar el objeto, así que el
validador **eliminaba en silencio** cualquier clave que no reconociera. Una
llamada con el nombre mal escrito, o con un parámetro que la herramienta no tiene,
respondía correctamente y sin lo pedido: el peor fallo posible, porque la
respuesta es válida y nadie sospecha de ella.

Las dieciocho herramientas rechazan ahora lo que no declaran, con un error que
nombra la clave:

```
MCP error -32602: Invalid arguments for tool jira_search: Unrecognized key: "fiedls"
```

El esquema que reciben los clientes lo dice también (`additionalProperties: false`),
de modo que la restricción es visible antes de llamar.

### `ping` dice qué código está corriendo, no qué código hay en disco

Leía la versión del `package.json` y la fecha del fichero compilado **en el momento
de preguntarlo**, las dos del disco. Así que respondía con la versión recién
compilada mientras el proceso seguía atendiendo con la anterior: decía que un
arreglo estaba puesto justo cuando no lo estaba, que es el único momento en que se
pregunta.

Su propia nota pedía comparar `built` con la última compilación para detectarlo,
pero `built` **era** la fecha de la última compilación, así que la comprobación no
podía fallar nunca.

Ahora la versión y la fecha son las del código que este proceso cargó, se informa
de la hora de arranque, y el disco se consulta solo para avisar de que ha quedado
por detrás:

```json
{
  "version": "1.3.0",
  "built": "2026-09-30T14:25:43.729Z",
  "started": "2026-10-09T09:12:00.000Z",
  "note": "Hay código compilado después del que cargó este proceso…",
  "stale": { "version": "1.4.0", "built": "2026-10-09T17:54:46.763Z" }
}
```

Se detecta también **recompilar sin subir la versión**, que antes era invisible por
partida doble: los dos números coincidían y la fecha venía del disco. El campo
`note` dice siempre el resultado de la comprobación —al día, por detrás, o no
comprobable—, porque un campo ausente se podía leer como cualquiera de los tres.

### Queda dicho que los campos personalizados hay que pedirlos

Las descripciones de las tres herramientas y el README dicen ahora lo que antes
había que deducir: sin `fields` los campos personalizados no vienen, y **su
ausencia en la respuesta no significa que el issue no los tenga**. Los dos casos
se leían igual, y de ahí sale el daño real: un ticket cuyos criterios de
aceptación viven en su campo se lee, sin `fields`, como un ticket sin criterios
—con el riesgo de escribir unos nuevos en la descripción, o de reescribir el
campo pisando las casillas que alguien hubiera marcado a mano—.

---

## 1.3.0 — 2026-09-30

### Las tablas en markdown se escriben como tablas

Una tabla con la sintaxis de GitHub —fila de cabecera, fila de guiones y filas de
cuerpo— se envía como tabla de Jira, con la primera fila como cabecera y el formato
en línea aplicado dentro de cada celda.

```markdown
| Campo | Valor |
| --- | --- |
| **Estado** | `OK` |
```

Antes cada fila se guardaba como un párrafo suelto, incluida la de guiones, que se
veía tal cual en pantalla. Y engañaba: la negrita y el código de las celdas sí se
aplicaban, así que un `dryRun` parecía correcto a primera vista.

La fila de guiones es obligatoria y debe tener tantas columnas como la cabecera; sin
ella, una línea con barras sigue siendo un párrafo. Un `\|` es una barra literal
dentro de una celda. La alineación de columnas (`:---:`) se acepta pero no se
traslada: Jira no la admite por columna.

---

## 1.2.0 — 2026-09-04

Tres correcciones sobre los campos de texto rico y la resolución de campos por
nombre, salidas del uso real en una instancia con varios proyectos.

### Los campos de texto rico son markdown, en las dos direcciones

Descripciones, comentarios y campos `textarea` se **leen** como markdown en lugar
de aplanados a texto corrido, y lo que se **escribe** se traduce al formato de la
API. Se cubren listas de tareas —las casillas marcables del editor—, listas con
viñetas y numeradas anidadas, encabezados, citas, bloques de código, reglas y, en
línea, negrita, cursiva, tachado, código y enlaces.

Antes, un campo convertido en lista de tareas desde la interfaz web volvía como una
cadena plana: se perdía que era una lista y el estado de cada casilla. Y no había
forma de crear una: todo lo enviado se guardaba como párrafos, así que un ticket
creado desde el servidor nunca tenía casillas marcables sin pasar por la interfaz.

```json
{ "customFields": { "Criterios de aceptación": "- [ ] Sin marcar\n- [x] Hecho" } }
```

Una línea suelta sigue siendo un párrafo: los saltos con los que se escribió el
texto se conservan tal como se ven en Jira. No se interpretan tablas escritas en
markdown —desde la 1.3.0 sí—; las que ya existen en Jira sí se leen como tabla.

### Un nombre de campo repetido ya no se lee como vacío

Una instancia puede tener varios campos con el mismo nombre visible, uno por
proyecto. Al leer un issue se piden todos los candidatos y se usa el que aplica a
ese proyecto, que es el caso normal. Si aplica más de uno, o ninguno, el error
enumera sus identificadores para poder elegir.

Antes se resolvía al primero del catálogo. En otro proyecto ese campo no tiene
valor, así que un ticket con criterios de aceptación se leía como si estuviera
vacío, sin ninguna señal de que la resolución del nombre había fallado.

### Un campo creado a mitad de sesión se resuelve sin reiniciar

El catálogo de campos se sigue cacheando al primer uso, pero un identificador
desconocido lo hace pedirse de nuevo antes de darlo por inexistente.

Antes se podía escribir un campo recién creado en Jira y no poder leerlo hasta
reiniciar la sesión, con un error que además afirmaba que no existía en la
instancia. Eso llevaba a pensar que la escritura había fallado y a repetirla.

### Qué revisar en las guías de equipo

- Donde se indique escribir criterios como `[ ] texto`, pasar a `- [ ] texto`: eso
  ahora produce casillas marcables de verdad, no un párrafo que las imita.
- Donde se describa la salida de `jira_get_issue` o `jira_explain_issue` como texto
  plano, decir markdown. Un asterisco o un guion de la salida es formato, no ruido.
- Donde se resuelva un campo por su nombre y el nombre esté repetido en la
  instancia, indicar el identificador (`customfield_10112`) en lugar del nombre.
- Retirar la indicación de reiniciar la sesión tras crear un campo en Jira.

---

## 1.1.0 — 2026-07-19

- `ping` informa de la versión y de la fecha de compilación del código en
  ejecución, para distinguir una capacidad que no existe de una que no está
  desplegada.
- Estimaciones, personas por correo o nombre, observadores y `dryRun` al crear.
- `JIRA_REQUIRED_FIELDS` para exigir los campos que un equipo da por obligatorios
  aunque Jira no los marque; en subtareas el requisito se comprueba contra el padre.
- Se avisa de los dos resultados que engañan sin dar error: la búsqueda vacía por
  tipo traducido y el campo obligatorio relleno solo con espacios.
- Las operaciones compuestas informan de lo que hicieron realmente, en vez de dar
  por hecho que todo salió bien.
- Ya bajo esta misma versión: `jira_list_projects` (2026-07-31) y las herramientas
  de sprint `jira_create_sprint` y `jira_move_to_sprint` (2026-08-15).

## 1.0.0 — 2026-07-18

Primera versión: lectura de issues, búsqueda por JQL, esquema de campos por tipo de
issue, creación, actualización, transiciones, enlaces, comentarios, registro de
tiempo, trabajo propio, resumen de proyecto y contexto completo de un issue.
