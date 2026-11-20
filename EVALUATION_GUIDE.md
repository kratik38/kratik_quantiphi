# Evaluation Guide

## Scope and verification honesty

This is a complete single-user application implementation. The production entry point uses the real official OpenAI SDK and a configurable persistent MongoDB URI. Controlled AI responses exist only in automated test fixtures. A live OpenAI request was subsequently attempted with a locally configured key; the upstream service returned `insufficient_quota` / `credit_balance_exhausted`, so successful live text generation remains unverified. A temporary real MongoDB process was used for API and browser verification; a user-managed persistent MongoDB deployment still needs configuration.

## Requirement mapping

| Mandatory requirement                     | Implementation                                                                                             | Verification                                                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1. Scrollable, distinct chat bubbles      | `client/src/App.tsx`, `components/ChatMessage.tsx`, `styles.css`                                           | Chrome desktop/mobile flows                                                                                          |
| 2. Character-by-character AI presentation | `client/src/context/ChatContext.tsx` uses incremental stream data and a 16 ms progressive animation buffer | Browser sees generating state and progressive response; backend test proves delta arrives before provider completion |
| 3. Retrieve previous threads              | `components/Sidebar.tsx`, Context, GET routes and Mongo repository                                         | CRUD integration; browser reload and thread selection                                                                |
| 4. Real backend OpenAI integration        | `server/src/services/ai.ts` official Responses SDK with `store:false`                                      | SDK request construction tested; live-key verification pending                                                       |
| 5. MongoDB persistence                    | `server/src/models/Conversation.ts`, `services/repository.ts`                                              | Real ephemeral Mongo CRUD, prompt-before-generation, completed response, failure and retry                           |
| 6. Three-option tone toggle               | Header select + Context                                                                                    | Browser changes tones and restores saved selection                                                                   |
| 7. Tone changes actual API instructions   | Exact trusted `TONE_INSTRUCTIONS` mapping + Responses `instructions`                                       | Tests assert all three exact instructions in SDK request; live response style pending                                |
| 8. Responsive UI and error/loading states | App, sidebar, input, message and styles                                                                    | Browser mobile fit, failure restoration and cancellation                                                             |

Paths in the table are relative to `client/src` unless prefixed with `server/`.

## Source guide

- `client/src/context/ChatContext.tsx`: history, active chat, tone, optimistic messages, abort handling, stale-generation guards and draft recovery.
- `client/src/services/api.ts`: native Fetch REST and incremental SSE decoding, including split Unicode/frame boundaries and terminal-event checks.
- `client/src/components/Sidebar.tsx`: history navigation, collapse, active thread, deletion confirmation.
- `client/src/components/ChatInput.tsx`: multiline input, Enter/Shift+Enter, disabled empty send, generation stop.
- `client/src/components/ChatMessage.tsx`: safe Markdown/GFM, fenced code, timestamp, copy and failure presentation. No raw HTML plugin is used.
- `client/src/App.tsx`: responsive shell, exact three-tone selector, welcome state, theme and near-bottom autoscroll.
- `server/src/app.ts`: REST endpoints, JSON/Zod validation, origin policy, streaming orchestration, safe errors and request deadline.
- `server/src/validation.ts`: trusted enums, MongoDB IDs, UUID requests and strict bodies.
- `server/src/models/Conversation.ts`: embedded ordered messages and timestamps.
- `server/src/services/repository.ts`: atomic leases, persistence, latest-activity order, replay/deduplication and expired-lease recovery.
- `server/src/services/ai.ts`: fixed tone prompts, bounded recent context and official OpenAI adapter.
- `server/src/services/sse.ts`: JSON SSE serialization.
- `server/src/index.ts`: local HTTP listener, Mongo connection/retry, signal shutdown.
- `server/tests/`: unit and real-Mongo API tests with an injected AI adapter.
- `client/src/services/api.test.ts`: frontend stream parser tests.
- `e2e/chat.spec.ts`, `scripts/e2e-server.ts`, `playwright.config.ts`: real-browser tests against Express and temporary MongoDB, using an explicitly controlled test-only AI provider.

## End-to-end message flow

1. New conversation opens a blank welcome view. The first send creates the database conversation; existing chats reuse their ID.
2. The browser displays the user prompt immediately, creates a UUID and POSTs message, conversation ID and selected tone. Server credentials never enter this payload.
3. Express checks input and acquires an atomic database lease for that conversation. Concurrent sends/edits are rejected with 409.
4. MongoDB records the user prompt as pending before AI work. The first prompt becomes a deterministic short title without another AI call.
5. The adapter builds bounded context from recent successful turns and the current prompt. Failed/cancelled turns are excluded.
6. The validated tone selects one of the exact three trusted instructions. The adapter sends it as `instructions` to the configured Responses-compatible model.
7. OpenAI emits incremental text. Express sends `start`, `delta` and heartbeat SSE frames, while the browser smoothly reveals the received text.
8. On explicit upstream completion, an atomic MongoDB pipeline completes the prompt, appends the answer with its timestamp/tone/request ID and releases the lease. A `done` event returns canonical database state.
9. The UI replaces optimistic state with canonical messages and refreshes the history list. Switching chats aborts and invalidates the old stream's callbacks.
10. Failures/cancellation retain the user prompt as failed/cancelled; partial assistant output is discarded. The browser restores the draft. Reusing the identical request UUID retries without a second stored prompt; replaying a completed UUID returns its stored answer. A conflicting payload is rejected. Only the latest failed turn may be retried.

## Tone behavior

Professional is the default. The options are exactly Professional, Casual and Concise. PATCH saves a selection immediately for existing conversations; the next send also carries that tone. Every message stores the tone in use, so earlier answers remain unchanged. Arbitrary client-supplied instructions are rejected by strict validation. Changing a saved tone and reopening the thread restores that selection.

Tests verify the **exact required instruction strings**, not merely a front-end style change. The official SDK call is intercepted only in tests to assert the model, instructions, context, `stream:true`, output limit and abort signal. Tone quality must additionally be demonstrated with a live model.

## Persistence and reliability choices

Messages are embedded in a conversation for atomic ordered updates. Status includes pending to represent accepted work. `requestId` associates a prompt and its answer; message IDs are generated server-side. Completion updates the prompt and appends the answer atomically with literal treatment of model text, including strings starting with `$`.

An internal 180-second lease prevents simultaneous requests across processes. On crash, a later read or send recovers an expired lease and marks pending work failed. A stream deadline is 120 seconds, shorter than the lease. Mongo connection loss returns a safe error and reconnects; if a failure status cannot be saved, lease recovery handles it later. A completed answer is never synthesized when the provider fails.

The test database is disposable. For persistence beyond application/database restarts, use the persistent local Mongo or Atlas setup in the README. No app state is stored only in an in-memory production repository.

## Run the demonstration

1. Follow README installation; set `MONGODB_URI`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `CLIENT_ORIGIN` and optional server port/host. Start MongoDB and run `npm run dev`.
2. Open `http://localhost:5173`. Show the empty state, disabled empty-send button, theme and mobile sidebar.
3. Send “Explain hashing to a software engineer” in Professional. Observe the immediate prompt, streaming indicator, incremental text and completed Markdown response.
4. Change to Casual and ask “Can you explain that with an analogy?” Then use Concise and ask “Summarize in two sentences.” Explain why the preceding conversation context is available.
5. Create a fresh chat; return to the earlier sidebar thread. Refresh and restart the API to demonstrate stored history and tone.
6. Stop a long response. Show the saved cancelled prompt, restored input and retry. With a controlled invalid API key, show the safe failure state and absence of fabricated output.
7. Delete a thread through its confirmation dialog. Verify it is absent after refresh.
8. Open browser Network: the request carries only conversation ID, prompt, tone and UUID; observe SSE frames and no OpenAI key. The browser communicates with Express, never directly with OpenAI.

## Verification record

Executed locally:

- Root TypeScript checks and both production builds.
- 39 backend tests (including 12 regeneration/search integration tests) and 7 frontend stream-parser tests.
- 8 Chrome end-to-end tests covering existing chat flows plus regeneration success/failure/cancellation, refresh persistence, title/content search, matching-message navigation/highlighting, clear/no-results/error states and mobile search.
- npm dependency audit after updating affected test dependencies: zero reported vulnerabilities.

Not executed with live external services:

- Successful live OpenAI generation and subjective style quality for the three tones (the attempted request was blocked by exhausted API credits).
- User-managed MongoDB/Atlas deployment, API-process restart against that persistent deployment, or production load testing.

### Manual acceptance checklist

| #   | Check                                    | Evidence/status                                                         |
| --- | ---------------------------------------- | ----------------------------------------------------------------------- |
| 1   | Opens without frontend errors            | Passed Chrome browser test, no page errors                              |
| 2   | Fresh chat                               | Passed; creates persisted conversation on first send                    |
| 3   | Submit prompt                            | Passed browser + API tests                                              |
| 4   | Backend calls OpenAI with configured key | SDK construction tested; live account pending                           |
| 5   | Progressive answer                       | Passed controlled streaming browser/API checks                          |
| 6   | Stream finishes                          | Passed terminal SSE and UI checks                                       |
| 7   | Prompt and response saved in MongoDB     | Passed real temporary Mongo tests                                       |
| 8   | Refresh retains conversations            | Passed browser reload                                                   |
| 9   | Sidebar history                          | Passed browser                                                          |
| 10  | Click loads messages                     | Passed browser                                                          |
| 11  | Professional model style                 | Exact instruction verified; live quality pending                        |
| 12  | Casual model style                       | Exact instruction verified; live quality pending                        |
| 13  | Concise model style                      | Exact instruction verified; live quality pending                        |
| 14  | Tone change alters next request          | Passed SDK/API and controlled browser checks                            |
| 15  | Delete database/UI                       | Passed API + browser                                                    |
| 16  | OpenAI error handling                    | Controlled failures and safe error mapping passed; live failure pending |
| 17  | Mongo failure handling                   | Disconnected repository integration check passed                        |
| 18  | Mobile usable                            | Chrome 390×844 viewport fit/sidebar passed                              |
| 19  | Key remains backend-only                 | Source/API design reviewed; no key in client or chat payload            |
| 20  | Multi-turn context                       | Passed backend context assertions and browser controlled provider       |

## Additional feature evaluation

### Regenerate AI response

- **Source:** `client/src/components/ChatMessage.tsx`, `App.tsx`, `context/ChatContext.tsx`, `services/progressiveStream.ts`; `server/src/app.ts`, `validation.ts`, `services/repository.ts` and the existing AI adapter.
- The circular-arrow action appears only on the latest completed assistant answer. A separate incremental preview preserves the original bubble until success. Request state disables overlapping actions; Stop and navigation abort the stream.
- `POST /api/chat/regenerate` validates `{conversationId, messageId, tone, requestId?}`. The existing SSE handler and OpenAI adapter are shared with normal sends.
- A database lease protects the snapshot. The server locates the target's original user prompt by its unchanged request ID and sends only the prefix through that prompt. The old answer and later messages never enter the regeneration context.
- Success atomically replaces content, timestamp and tone of the same assistant message. User prompt, message ID, order and later entries stay intact. Failure/cancellation releases the lease without modifying messages. The browser reconciles canonical state if delivery fails after a database commit.
- **Schema:** one backward-compatible optional `regenerationRequestId` field records the last successful regeneration UUID without overwriting the original prompt/answer request ID. No migration or extra collection is needed. The optional API UUID permits replay of that successful result; original answer versions are not retained.

### Search conversation history

- **Source:** `client/src/components/Sidebar.tsx`, `context/ChatContext.tsx`, `App.tsx`, `components/ChatMessage.tsx`, `styles.css`; `server/src/app.ts`, `validation.ts`, `services/repository.ts`.
- `GET /api/conversations/search?q=keyword` is registered before `/:id`, validates a trimmed 1–100-character query and performs literal case-insensitive MongoDB matching on title and message content.
- The aggregation escapes regex characters, limits results to 20, caps execution at 2 seconds, orders by activity then ID, and returns only title/tone/timestamps, a short matching snippet and stable message ID. Title-only results use a null message ID.
- The sidebar debounces 300 ms, aborts stale requests, handles loading/errors/no results, and safely renders excerpts without raw HTML. Clear restores normal history. Selecting a result loads its persisted conversation, scrolls to the first matching message and highlights it, including on mobile.
- **Schema:** search uses existing content and message IDs. No search index or schema migration is introduced. Regex substring queries may scan documents, so large datasets would need an indexed search design.

### Demonstration and test coverage

1. Generate an answer, change tone, and click **Regenerate response**. Confirm the old answer remains visible while the preview streams. After completion, refresh and show the replacement with the same number of messages.
2. Stop a regeneration and demonstrate the original answer remains. With a controlled provider error, show the same preservation and error feedback.
3. Start a fresh chat, refresh, and search for a phrase that appears only in an older stored message. Open its result and show the message highlight. Search for a title, then an unmatched phrase, and clear the query.
4. Repeat search navigation with a mobile viewport. The sidebar closes and the matching bubble scrolls into view.

`server/tests/features.integration.test.ts` exercises both endpoints against real temporary MongoDB with a controlled AI adapter. `e2e/features.spec.ts` covers the UI workflows against Express and MongoDB. Existing tests continue covering normal chat, tones, failures, context and streaming. Live OpenAI regeneration is still subject to the exhausted-credit limitation noted above; automated tests do not claim a successful live-provider response.

## Interview discussion prompts

- Why use Fetch with SSE rather than EventSource or WebSockets for a POST-driven text stream?
- Where do optimistic UI state and authoritative MongoDB state meet?
- Why persist a prompt before calling a potentially failing dependency?
- How do request IDs and database leases solve different concurrency problems?
- How does abort propagation work when the browser closes the connection?
- Why must completion be explicit before storing an assistant answer?
- Why are CORS and a loopback listener insufficient substitutes for authentication on a public service?
- What are the tradeoffs of embedded messages and byte-bounded context?
- How would you add pagination, token counting, multi-user authorization and distributed rate limits?
- Which tests use a real database, which use a controlled provider, and which still require a live account?
