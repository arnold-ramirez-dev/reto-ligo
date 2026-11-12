# Wallet Cash-In — Senior Backend Challenge

Implementación en **NestJS + TypeScript + PostgreSQL** de un Cash-In de wallet con idempotencia multi-pod, control de concurrencia, máquina de estados, reconciliación y recepción segura de webhooks.

> Decisión central: un timeout no significa que el cobro falló. Ante cualquier resultado no determinable, la operación queda en `UNKNOWN`; nunca se crea otro cobro con una nueva identidad. La reconsulta/reintento utiliza el mismo identificador durable frente al proveedor.

## Ejecución rápida

Requisitos: Docker Desktop / Docker Engine con Docker Compose v2 y Node.js 20+.

```bash
docker compose up -d
npm ci
npm run migration:up
npm run start:dev
```

`docker-compose.yml` deja solamente PostgreSQL activo para evitar reconstruir imágenes durante el desarrollo. La API corre localmente y se conecta con `postgresql://cashin:cashin@localhost:5432/cashin` (ver `.env.example`).
El proyecto carga el archivo `.env` automáticamente para las migraciones, la API y el simulador. `PORT` corresponde exclusivamente a la API y `PAYMENT_PROVIDER_PORT` al simulador, evitando conflictos entre ambos procesos locales.

Cuando `GET http://localhost:3000/health` responda `{"status":"ok"}`, se puede ejecutar:

```bash
curl --request POST http://localhost:3000/cash-in \
  --header 'Content-Type: application/json' \
  --header 'Idempotency-Key: 3fa85f64-5717-4562-b3fc-2c963f66afa6' \
  --data '{"user_id":"usr_abc123","amount":100.00,"currency":"PEN","payment_method":"card_success"}'
```

La documentación interactiva OpenAPI queda disponible en **http://localhost:3000/docs** y el contrato JSON en **http://localhost:3000/docs-json**.

Respuesta esperada:

```json
{
  "operation_id": "<uuid>",
  "status": "completed",
  "amount": 100,
  "new_balance": 100
}
```

Para reiniciar desde cero (incluye datos), usar `docker compose down -v`.

## Contrato

### `POST /cash-in`

Header obligatorio:

```http
Idempotency-Key: <UUID v1-v8>
```

Body:

```json
{
  "user_id": "usr_abc123",
  "amount": 100.0,
  "currency": "PEN",
  "payment_method": "card_success"
}
```

| HTTP | Cuándo                                                                      | Respuesta `status`       |
| ---: | --------------------------------------------------------------------------- | ------------------------ |
|  200 | Cobro y asiento de wallet confirmados; o replay del resultado ya confirmado | `completed`              |
|  202 | Hay otro pod procesando, o el resultado externo aún es incierto             | `processing` / `unknown` |
|  422 | El proveedor confirmó un rechazo                                            | `failed`                 |
|  409 | La misma `Idempotency-Key` fue usada con un body semánticamente distinto    | —                        |

Los montos se reciben con dos decimales y se convierten a enteros (`amount_minor`) antes de persistir. El contrato admite solamente `PEN` para mantener el alcance del challenge explícito.

### `POST /webhooks/payment`

El proveedor debe enviar un body como:

```json
{
  "provider_event_id": "evt_01H...",
  "operation_id": "<uuid>",
  "payment_id": "pay_01H...",
  "type": "payment.succeeded",
  "occurred_at": "2026-08-01T10:00:00.000Z"
}
```

Se valida `X-Provider-Signature: sha256=<HMAC del body crudo>`. Cada `provider_event_id` tiene una restricción `PRIMARY KEY`: un webhook duplicado devuelve 200 sin volver a alterar saldo o ledger.

## Arquitectura

```mermaid
flowchart LR
  App["App / reintento"] --> API["NestJS Cash-In API"]
  API --> DB["PostgreSQL\noperación + ledger + outbox"]
  API --> PSP["Payment Provider\nmisma clave durable"]
  PSP --> WH["Webhook firmado"]
  WH --> DB
  Worker["Reconciliación"] --> DB
  Worker --> PSP
```

PostgreSQL es el origen de verdad para la operación, el saldo y el ledger. No hay locks en memoria, Redis local ni una transacción de base de datos abierta durante una llamada HTTP al proveedor; cualquiera de estas opciones fallaría al escalar a varios pods o degradaría innecesariamente la base de datos.

El `payment-provider` incluido es un simulador aislado para validar el flujo de punta a punta. En producción se reemplaza por un adaptador HTTP/SDK del PSP, conservando el contrato de `PaymentProvider`.

## Máquina de estados

```mermaid
stateDiagram-v2
  [*] --> PENDING: INSERT único por Idempotency-Key
  PENDING --> PROCESSING: lease PostgreSQL
  PROCESSING --> COMPLETED: respuesta o webhook exitoso
  PROCESSING --> FAILED: rechazo confirmado
  PROCESSING --> UNKNOWN: timeout / transporte incierto
  UNKNOWN --> COMPLETED: consulta PSP o webhook
  UNKNOWN --> FAILED: consulta PSP o webhook
  UNKNOWN --> PROCESSING: PSP confirma ausencia; reenvío con misma clave
  COMPLETED --> [*]
  FAILED --> [*]
```

`COMPLETED` y `FAILED` son terminales. Un webhook tardío o fuera de orden se almacena para auditoría, pero no degrada una operación terminal ni genera un segundo movimiento. Si llegara un caso de disputa real entre resultados terminales, se deriva a reconciliación/operaciones, no se “corrige” el saldo automáticamente.

## Idempotencia y concurrencia

1. Se calcula `request_hash = SHA-256(user_id, amount_minor, currency, payment_method)`.
2. Se intenta insertar `cash_in_operations` con `UNIQUE(idempotency_key)`. Esa restricción funciona entre procesos, réplicas y reinicios.
3. Si la clave ya existe, el hash debe coincidir. Con el mismo request se devuelve el resultado persistido; con otro request se responde `409`.
4. Solo el pod que obtiene el lease `SELECT ... FOR UPDATE` cambia a `PROCESSING` y llama al PSP.
5. El identificador de la operación (`operation.id`) se pasa al PSP como su `Idempotency-Key`. Ante caída después de enviar el request, reenviar **la misma clave** hace que el PSP retorne el mismo cobro, no cree otro.
6. Al completar, una transacción bloquea la operación, incrementa el wallet en SQL, inserta `wallet_ledger_entries` con `UNIQUE(operation_id)` y actualiza la operación. El commit es atómico; el saldo no se duplica aunque respuesta y webhook compitan.

La garantía interna es _exactly-once ledger credit_. Para afirmar que el cobro externo también es _exactly-once_ se requiere, de manera explícita, que el PSP mantenga idempotencia durable por la clave enviada. Sin esa propiedad, después de un timeout ningún servicio puede distinguir de forma segura “no llegó” de “cobró y perdió la respuesta”; prometerlo sería incorrecto. Esa es una dependencia contractual que validaría con el PSP antes de producción (retención de la clave, comportamiento ante body diferente y endpoint de consulta).

## Timeouts, retries y reinicios

- No se reintenta ciegamente un POST financiero tras un timeout.
- Un timeout, error de red o respuesta no interpretable se persiste como `UNKNOWN` y devuelve 202.
- El reconciliador consulta primero `GET /payments/by-idempotency/{operationId}`. Solo si el proveedor confirma que no existe, reclama un lease y envía de nuevo con la **misma** clave externa.
- Un `PROCESSING` abandonado se recupera cuando vence su lease de 30 s. Un reinicio entre el INSERT y la llamada, o durante la llamada, no borra el estado.
- Los rechazos confirmados no se reintentan automáticamente y quedan en `FAILED`.

## Modelo de persistencia

| Tabla                    | Propósito / invariantes                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `cash_in_operations`     | Intento de negocio; `UNIQUE(idempotency_key)`, request fingerprint y estado persistente.                |
| `wallets`                | Saldo en unidades menores; el `UPDATE balance = balance + amount` serializa créditos del mismo usuario. |
| `wallet_ledger_entries`  | Auditoría inmutable de crédito; `UNIQUE(operation_id)` evita doble abono.                               |
| `payment_webhook_events` | Inbox del proveedor; `PRIMARY KEY(provider_event_id)` deduplica entregas.                               |
| `outbox_events`          | Evento de dominio insertado en la misma transacción del abono, listo para un publicador confiable.      |

## Pruebas

Pruebas unitarias incluidas:

```bash
npm ci
npm run build
npm test
```

Cubren éxito, replay idempotente sin segundo cobro, timeout incierto, fallo confirmado y recepción duplicada de webhook firmado.

Prueba end-to-end con la base Dockerizada y los procesos Node locales:

```bash
docker compose up -d
npm ci
npm run migration:up
npm run start:simulator
# En otra terminal: npm run start:dev
# En otra terminal, cuando ambos estén arriba:
npm run test:e2e
```

El e2e envía cinco requests concurrentes con la misma clave y valida una sola `operation_id` y un replay estable, además del rechazo confirmado por el PSP.

### Escenarios deterministas del simulador

Se seleccionan con `payment_method` para poder demostrar casos difíciles sin depender de un PSP real:

| `payment_method`            | Comportamiento                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `card_success`              | Éxito inmediato.                                                                                                     |
| `card_declined`             | Rechazo confirmado.                                                                                                  |
| `card_timeout_after_charge` | El PSP registra éxito pero responde después de 5 s; la API queda `UNKNOWN` y el reconciliador consulta el resultado. |
| `card_webhook_first`        | El webhook exitoso llega antes de la respuesta del POST.                                                             |
| `card_webhook_duplicate`    | Envía el mismo webhook dos veces.                                                                                    |
| `card_webhook_failed`       | Notifica fracaso firmado.                                                                                            |

## Observabilidad y operación

- `X-Request-Id` se acepta o se genera y se devuelve en cada respuesta.
- Logs JSON incluyen evento, operación y duración HTTP; nunca registran datos de tarjeta ni secreto de webhook.
- Índice parcial para operaciones `UNKNOWN`/leases expirados del reconciliador.
- Migraciones versionadas y aplicadas de modo serial antes del arranque de la API.
- El pool de PostgreSQL está acotado; no se mantiene una transacción mientras se invoca una dependencia de red.

Para un volumen de un millón de operaciones/día, separaría el publicador de `outbox_events`, usaría un worker con `FOR UPDATE SKIP LOCKED` para reparto horizontal, instrumentaría métricas de pendientes/reconciliaciones/latencia del PSP y particionaría tablas de ledger/eventos por fecha. Redis podría aportar rate limit o caché de lectura, pero **no** reemplazaría las restricciones y transacciones de PostgreSQL para esta garantía financiera.

## Pilotaje de IA: especificación, revisión y correcciones

El uso de IA fue guiado por una especificación restrictiva, no por “genera un endpoint de cobro”. La instrucción de diseño fue:

> Diseña en NestJS un cash-in multi-pod. Persiste una operación antes de contactar al PSP. La idempotencia debe sobrevivir reinicios y tener un hash de request; usa transacciones y restricciones de PostgreSQL, no memoria local. No mantengas una transacción abierta durante HTTP. Modela `UNKNOWN` cuando no pueda conocerse el resultado de un cobro. El PSP debe recibir una clave de idempotencia estable, deben existir webhooks firmados/deduplicados y tests de concurrencia, replay, éxito, fallo y timeout.

Revisión crítica aplicada al resultado inicial:

| Riesgo detectado                                       | Corrección aplicada                                                                                  |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| “Marcar fallo” ante timeout o error de red             | Se cambió por `UNKNOWN`: no existe evidencia suficiente para afirmar que no cobró.                   |
| Reintentar el POST financiero con una clave nueva      | El reintento usa siempre `operation.id` como clave externa; primero consulta al PSP.                 |
| Idempotencia resuelta con un cache/lock local          | Se reemplazó por `UNIQUE(idempotency_key)`, hash de request y row locks en PostgreSQL.               |
| Respuesta del PSP y webhook pueden acreditar dos veces | Se centralizó el cierre en una transacción con `UNIQUE(operation_id)` en ledger.                     |
| Un webhook tardío podría sobrescribir éxito            | Los estados terminales son inmutables; los eventos se guardan como evidencia sin modificar el saldo. |
| Publicar un evento después del commit puede perderse   | Se agregó outbox transaccional para publicación posterior.                                           |

## Alcance deliberado

El simulador de pagos y el HMAC existen para demostrar el comportamiento ejecutable. Un ambiente productivo agregaría autenticación/autorización de API, rotación de secretos en un vault, mTLS/allowlist con el PSP, cifrado/tokenización de medios de pago, rate limiting, alertas y un flujo formal de conciliación manual para conflictos externos. Esas capacidades no se inventan dentro del challenge: se diseñan como requisitos de plataforma y seguridad.
