import { Rpc } from "@opencode/plugin/rpc";

export interface UiResult {
  id: string;
  segment: string;
  at: number;
  summary: string;
  proposed: number;
  applied: number;
  reportPath: string;
}

export interface UiSnapshot {
  project: string;
  enabled: boolean;
  analysisEnabled: boolean;
  counts: { entries: number; review: number };
  entries: { id: string; type: string; title: string; content: string; rationale?: string }[];
  matching: number;
  proposals: { id: string; title: string; content: string; kind: string; rationale?: string; reason: string | null; human: boolean; fingerprint: string }[];
  analysis: { state: string; message: string; due: number | null };
  result: UiResult | null;
  lastReport: UiResult | null;
}

const sessionProperties = { sessionID: { type: "string", minLength: 1, maxLength: 200 } } as const;
const objectOutput = { type: "object", additionalProperties: true } as const;

export const ArchivistRpc = Rpc.define({
  id: "archivist",
  methods: {
    snapshot: {
      input: { type: "object", properties: { ...sessionProperties, query: { type: "string", maxLength: 500 } }, required: ["sessionID"], additionalProperties: false },
      output: objectOutput,
    },
    report: {
      input: { type: "object", properties: sessionProperties, required: ["sessionID"], additionalProperties: false },
      output: objectOutput,
    },
    settle: {
      input: {
        type: "object",
        properties: { ...sessionProperties, id: { type: "string", minLength: 1, maxLength: 200 }, fingerprint: { type: "string", minLength: 64, maxLength: 64 }, action: { type: "string", enum: ["apply", "skip"] } },
        required: ["sessionID", "id", "fingerprint", "action"], additionalProperties: false,
      },
      output: objectOutput,
    },
  },
  events: { changed: { schema: { type: "object", additionalProperties: false } } },
});
