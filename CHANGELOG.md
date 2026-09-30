# Changelog

Cambios que afectan a quien usa el servidor. Las versiones anteriores a la 1.2.0
se reconstruyen del historial: hasta entonces no había este fichero.

Tras actualizar hay que ejecutar `npm run build` **y reiniciar la sesión de Claude
Code**: el cliente arranca el servidor al abrirla y mantiene ese proceso mientras
dura. `ping` devuelve la versión y la fecha del código en ejecución.

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
