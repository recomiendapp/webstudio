# Diseño: Motor de IA in-app (Amazon Bedrock)

Feature: chat de IA dentro del builder de Webstudio que genera/edita contenido
aplicando las _runtime operations_ existentes. Proveedor LLM: **Amazon Bedrock**
(Claude 3.5 Sonnet). Enfoque: **IA in-app nativa** (server-side, sin subproceso
MCP, sin agentes externos).

---

## 1. Principio de diseño

Webstudio ya tiene todo el "andamiaje" para edición por IA. Solo falta el
cliente LLM y la superficie in-app. Reutilizamos:

- **Runtime operations** como herramientas del LLM (insert-fragment, update-styles, …).
- **Ejecución in-process**: `executeApiRuntimeMutation()` (`apps/builder/app/services/api-runtime.server.ts:62`).
- **Commit de cambios**: `commitBuildPatch` / `commitBuildTransactions` (usados en `api-router.server.ts:73-74`).
- **Carga de proyecto**: `loadBuilderDataByProjectId` / `loadDevBuildByProjectId` (`build-router.server.ts`).
- **Auth**: `createContext`, `assertApiProjectPermit`, `preventCrossOriginCookie`, `checkCsrf`.
- **Specs para LLM**: `projectBuildDocs` (`packages/project-build/src/docs.generated.ts`), `webstudioJsxFragmentInputDescription` (`packages/project-build/src/runtime/jsx/bindings.ts:75`).
- **Pipeline JSX**: `parseWebstudioJsxFragment` (para que el LLM escriba JSX de Webstudio).

**No usamos** el servidor MCP (`packages/project-build/src/mcp.ts`): es stdio y
está acoplado a la `ProjectSession` del CLI. In-app ejecutamos las ops directamente.

---

## 2. Arquitectura general

```
Builder UI (React)                         Servidor (Remix, Node 22)
┌────────────────────────┐                 ┌───────────────────────────────────┐
│ Panel de chat          │  POST stream    │ rest.ai.$projectId.ts             │
│ (sidebar-left)         │ ───────────────▶│                                   │
│  - input               │                 │ 1. auth (context + permit)        │
│  - historial           │                 │ 2. loadBuilderData(projectId)     │
│  - estado tool calls   │ ◀─────────────── │ 3. Bedrock Converse (tools)       │
└────────────────────────┘   SSE / stream  │ 4. loop tool calls:               │
        │                                   │    executeApiRuntimeMutation      │
        │ el canvas se refresca solo        │    + commitBuildPatch             │
        │ (sync client detecta nueva ver.)  │ 5. stream respuesta + eventos     │
        ▼                                   └───────────────────────────────────┘
   Canvas actualizado                                │
                                            Amazon Bedrock (Claude 3.5 Sonnet)
```

Flujo de una petición:

1. El usuario escribe un mensaje en el panel de chat.
2. `POST /rest/ai/:projectId` con `{ messages, ... }` (streaming).
3. El servidor autentica y carga el build actual del proyecto (`CompactBuild`).
4. Llama a Bedrock (Converse API) con:
   - **system prompt** = specs de Webstudio + instrucciones de la tarea.
   - **tools** = subconjunto de runtime operations (schemas zod → JSON Schema).
   - **messages** = historial de la conversación.
5. Bedrock responde con texto y/o `toolUse` (llamadas a herramientas).
6. Por cada `toolUse`:
   - `executeApiRuntimeMutation({ id, build, input })` valida y produce un `payload`.
   - `commitBuildPatch({ build, ctx, projectId, payload })` aplica el cambio → nueva `version`.
   - Se recarga el build y se devuelve el `toolResult` a Bedrock (con error zod si falló, para auto-corrección).
7. Se repite hasta que Bedrock deja de pedir herramientas (o se alcanza un límite de turnos).
8. Se transmite la respuesta final al chat; el sync client del builder detecta la nueva versión y refresca el canvas.

---

## 3. Componentes nuevos

### 3.1 Cliente Bedrock — `packages/ai` (nuevo paquete)

- Dependencia: `@aws-sdk/client-bedrock-runtime` (Converse / ConverseStream API).
- Exports:
  - `createBedrockClient(config)` — cliente configurado por env.
  - `converse({ system, messages, tools, ... })` — wrapper tipado.
  - `converseStream(...)` — versión streaming (para UI).
- Config vía env (ver §6). Usa el IAM role del contenedor (sin API keys).

> Alternativa: no crear paquete y poner el cliente en `apps/builder/app/services/ai/`.
> Recomendado paquete propio para poder testearlo aislado y reutilizarlo.

### 3.2 Catálogo de herramientas — `ai/tools.server.ts`

Mapea runtime operations → tools de Bedrock:

```
tool = {
  name: operation.command,           // p.ej. "insert-fragment"
  description: operation.description, // de operation-docs.ts
  inputSchema: zodToJsonSchema(operation.inputSchema),
}
```

**Subconjunto inicial** (incremento 1, mutaciones de contenido):
- `insert-fragment` — insertar JSX de Webstudio (la principal).
- `update-styles` — estilos.
- `update-text` / `set-text-content` — texto.
- `list-pages`, `get-page`, `list-instances`, `search-project` — lectura/contexto.

Se amplía luego a props, variables, componentes, etc.

### 3.3 Ruta — `apps/builder/app/routes/rest.ai.$projectId.ts`

Espeja `rest.data.$projectId.ts` para auth/carga, más el loop LLM:

```
action(request):
  preventCrossOriginCookie(request)
  checkCsrf(request)
  ctx  = await createContext(request)
  auth = await assertApiProjectPermit({ projectId, permit: "build", ctx })
  build = await loadBuilderDataByProjectId(projectId, ctx)   // CompactBuild + assets
  messages = parse(request.body)

  loop (max N turnos):
    resp = await converse({ system, tools, messages })
    if resp.stopReason !== "tool_use": break
    for toolUse in resp.toolCalls:
      op = getBuilderRuntimeOperation(toolUse.name)
      try:
        mutation = executeApiRuntimeMutation({ id: op.id, build, input: toolUse.input })
        if mutation.payload.length > 0:
          { version } = await commitBuildPatch({ build, ctx, projectId, payload: mutation.payload })
          build = await loadBuilderDataByProjectId(projectId, ctx)  // recarga
        toolResult = { ok: true, result: mutation.result }
      catch (BuilderRuntimeError e):
        toolResult = { ok: false, error: e.message, issues: e.issues }  // → auto-correccion
      messages.push(toolResult)

  stream(resp.text)
```

Notas:
- `permit: "build"` para poder mutar instancias/estilos (o `edit` si se limita a content mode).
- Recargar el build tras cada commit evita conflictos de versión.
- Los `BuilderRuntimeError` (zod) se devuelven al LLM como `toolResult` de error → el modelo se auto-corrige (patrón ya validado por el harness de evals).

### 3.4 UI — panel de chat en `sidebar-left`

- Nuevo `PanelConfig` en `apps/builder/app/builder/sidebar-left/` (`types.ts` + `sidebar-left.tsx:117`).
- Componente de chat: recuperar `autogrow-text-area.tsx` y `command-bar.tsx` del commit `33d640f7a` (fueron borrados en `b67aaafe1`), o construir uno simple con primitivas de `@webstudio-is/design-system`.
- Estado: historial de mensajes (nano-store), indicador de "pensando" / tool calls en curso.
- Al recibir la respuesta, no hay que refrescar el canvas manualmente: el sync client detecta la nueva `version` del build.

---

## 4. System prompt del LLM

Se compone de piezas ya existentes:

1. `projectBuildDocs["mcp-startup-guidance"]` — flujo de trabajo (qué mirar primero).
2. `projectBuildDocs["expressions"]` — sintaxis de expresiones/variables.
3. `webstudioJsxFragmentInputDescription` — cómo escribir JSX de Webstudio para `insert-fragment`.
4. `publicApiOperationDocumentation` — catálogo de operaciones (descripción + ejemplos).
5. Instrucciones propias: idioma, tono, restricciones (no borrar sin confirmación, etc.).

Contexto dinámico por petición (resumen del proyecto): páginas, componentes
disponibles, id de la página/instancia seleccionada (para saber dónde insertar).

---

## 5. Contrato de la API (borrador)

`POST /rest/ai/:projectId`

Request:
```jsonc
{
  "messages": [
    { "role": "user", "content": "Añade una sección hero con título y botón" }
  ],
  "context": {
    "selectedInstanceId": "abc",   // opcional: dónde insertar
    "selectedPageId": "home"
  }
}
```

Response (streaming, SSE o chunked):
```
event: text        data: "Voy a crear la sección hero…"
event: tool_start  data: { "name": "insert-fragment" }
event: tool_end    data: { "name": "insert-fragment", "ok": true, "version": 43 }
event: text        data: "Listo, he añadido el hero."
event: done        data: { "version": 43 }
```

---

## 6. Variables de entorno

| Variable | Descripción | Ejemplo |
|---|---|---|
| `BEDROCK_REGION` | Región de Bedrock | `us-east-1` |
| `BEDROCK_MODEL_ID` | Modelo | `anthropic.claude-3-5-sonnet-20241022-v2:0` |
| `AI_ENABLED` | Feature flag on/off | `true` |
| `AI_MAX_TURNS` | Límite de turnos de tool-use | `12` |
| (credenciales) | IAM role del contenedor (preferido) o `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` | — |

Añadir el schema en `apps/builder/app/env/env.server.ts` y las variables al
`docker-compose-new.yml` (con defaults `${VAR:-}` como el resto).

---

## 7. Seguridad y límites

- **Auth**: reutiliza el sistema de permits. El chat requiere sesión de usuario
  con permit `build` sobre el proyecto (o `edit` para content mode).
- **CSRF / cross-origin**: `preventCrossOriginCookie` + `checkCsrf` como el resto de rutas del builder.
- **Rate limiting**: límite de turnos (`AI_MAX_TURNS`) y, opcional, límite de
  peticiones por usuario/día (reutilizable del contador de publishes).
- **Sandbox**: las runtime ops ya validan input (zod) y content-model; el LLM no
  puede ejecutar nada fuera del catálogo de herramientas.
- **Coste**: registrar tokens usados por petición (Bedrock los devuelve) para métricas.

---

## 8. Incrementos de entrega

**Incremento 1 — Backend end-to-end (sin UI):**
- Paquete `packages/ai` con cliente Bedrock (Converse).
- `ai/tools.server.ts` con `insert-fragment` + 2-3 ops de lectura.
- Ruta `rest.ai.$projectId.ts` con el loop de tool-use + commit.
- Env + docker-compose.
- Test: `curl` con un prompt → verifica que se crea contenido y sube la versión.

**Incremento 2 — UI de chat:**
- Panel en `sidebar-left`.
- Componente de chat (recuperar `autogrow-text-area` o nuevo).
- Streaming de respuestas + estado de tool calls.

**Incremento 3 — Robustez:**
- Loop multi-turn con auto-corrección por errores zod.
- Verificación visual (screenshots con `packages/vision`).
- Rate limiting, métricas de tokens, manejo de errores.
- Ampliar el catálogo de tools.

---

## 9. Riesgos / decisiones abiertas

1. **`zodToJsonSchema`**: los input schemas de las ops son zod; Bedrock necesita
   JSON Schema. Verificar que la conversión cubre todos los tipos usados (o usar
   el JSON Schema ya generado en los contratos `runtime-operation-contracts.ts`).
2. **Streaming vs no-streaming**: incremento 1 puede ser sin streaming (más
   simple); UI en incremento 2 con streaming.
3. **Content mode vs build**: decidir si el chat opera en modo `edit` (limitado,
   más seguro) o `build` (control total). Recomendado `build` para el creador.
4. **Divergencia con upstream**: esta feature es 100% propia del fork; aislarla
   en `packages/ai` + una ruta y un panel minimiza conflictos en futuros merges.
5. **Modelo**: Claude 3.5 Sonnet en Bedrock. Confirmar acceso al modelo habilitado
   en la cuenta AWS (Bedrock requiere "model access" explícito por región).
