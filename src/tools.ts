/**
 * Browser tool definitions, shared by both drive paths:
 *
 *  - the API path (src/agent.ts) casts these to Anthropic tool params
 *  - the harness path (src/mcp.ts) re-exports them over MCP
 *
 * Keeping one definition means the hard-won guidance in these descriptions
 * ("a ref marked 'scrollable' is a list with its own scrollbar", "readonly
 * fields open a picker instead of typing") reaches whichever model is driving.
 */

export interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "navigate",
    description:
      "Navigate the browser to a URL (must stay on the target site's origin). Returns a text snapshot of the resulting page.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute URL to open" } },
      required: ["url"],
    },
  },
  {
    name: "snapshot",
    description:
      "Take a full text snapshot of the current page: URL, title, aria outline, and every interactive element with its ref. Expensive — actions already report the URL and any new elements, and refs stay valid, so use this on arriving at an unfamiliar page or when a ref errors as stale, not routinely after each action.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "click",
    description:
      "Click an element by its ref (e.g. 'e12'). Returns the resulting URL and any interactive elements that newly appeared — refs you already have keep working, so you rarely need a snapshot afterwards.",
    input_schema: {
      type: "object",
      properties: { ref: { type: "string" } },
      required: ["ref"],
    },
  },
  {
    name: "fill",
    description:
      "Clear and type text into an input, textarea, or rich-text editor identified by ref. Date/time fields accept human wording ('March 5, 2026', '9:30 AM') — they are converted to the format the field requires. A field marked 'readonly' cannot be typed into: filling it clicks it instead, which usually opens a picker, and the result lists the picker's options as new elements.",
    input_schema: {
      type: "object",
      properties: { ref: { type: "string" }, text: { type: "string" } },
      required: ["ref", "text"],
    },
  },
  {
    name: "select",
    description:
      "Choose an option in a dropdown by visible label. Works for a native <select> AND for custom dropdowns/comboboxes (refs marked 'dropdown', or any div/button that opens a list) — it opens the control, types to filter if needed, and clicks the matching option. If the value does not match, the error lists the options that were actually available.",
    input_schema: {
      type: "object",
      properties: { ref: { type: "string" }, value: { type: "string" } },
      required: ["ref", "value"],
    },
  },
  {
    name: "drag",
    description:
      "Drag one element onto another (both refs from the latest snapshot). Use for drag-and-drop UIs — agenda/schedule builders usually place sessions this way. If a builder also offers click-to-select then click-a-slot, either approach is fine.",
    input_schema: {
      type: "object",
      properties: {
        from_ref: { type: "string", description: "Element to drag, e.g. an unscheduled session card" },
        to_ref: { type: "string", description: "Drop target, e.g. a time slot cell" },
      },
      required: ["from_ref", "to_ref"],
    },
  },
  {
    name: "upload",
    description:
      "Upload a fixture file through a file input or an upload button (ref from the latest snapshot). fixture: 'headshot' (PNG), 'slides' (PDF), or 'speakers_csv' (CSV).",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        fixture: { type: "string", enum: ["headshot", "slides", "speakers_csv"] },
      },
      required: ["ref", "fixture"],
    },
  },
  {
    name: "press",
    description: "Press a keyboard key (e.g. 'Enter', 'Escape', 'Tab').",
    input_schema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "scroll",
    description:
      "Scroll up or down by roughly one viewport. Pass ref to scroll a specific list instead of the page — long session/speaker/submission lists often live in their own scroll box (refs marked 'scrollable') or load more rows only when that box is scrolled, so a short-looking list is usually not a short list.",
    input_schema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"] },
        ref: {
          type: "string",
          description: "Optional: a ref inside the list/container to scroll instead of the whole page",
        },
      },
      required: ["direction"],
    },
  },
  {
    name: "wait",
    description: "Wait for the page to settle (max 8000ms). Use sparingly for slow-loading UI.",
    input_schema: {
      type: "object",
      properties: { ms: { type: "number" } },
      required: ["ms"],
    },
  },
  {
    name: "screenshot",
    description:
      "Capture a screenshot as visual evidence. ALWAYS screenshot key states: filled forms before submit, confirmation screens, lists/dashboards with data, anything a judge needs to see. Give a short descriptive label.",
    input_schema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Short kebab-case label, e.g. 'cfp-form-filled'" },
        full_page: { type: "boolean", description: "Capture the full scrollable page (default false)" },
      },
      required: ["label"],
    },
  },
  {
    name: "observe",
    description:
      "Record a factual observation for the judge (feature present/absent, validation behavior, data shown, bugs). Use liberally — observations are primary evidence.",
    input_schema: {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
    },
  },
  {
    name: "done",
    description:
      "End the scenario. outcome: 'completed' (script finished, whether or not every check passed), 'blocked' (could not finish — say why), or 'feature_not_found' (searched thoroughly; feature appears absent).",
    input_schema: {
      type: "object",
      properties: {
        outcome: { type: "string", enum: ["completed", "blocked", "feature_not_found"] },
        summary: {
          type: "string",
          description: "Concise factual summary of what happened and what was verified",
        },
      },
      required: ["outcome", "summary"],
    },
  },
];
