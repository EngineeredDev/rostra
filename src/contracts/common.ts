import { z } from "zod/v4";

export const uuidSchema = z.uuid();
export const nonemptyStringSchema = z.string().trim().min(1);
export const slugSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const participantIdSchema = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .pipe(slugSchema);
export const domainTagSchema = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .pipe(slugSchema);
export const cursorSchema = z.string().min(1).optional();
export const executionIsolationSchema = z.enum(["builtin_confined", "host_unrestricted"]);

export const participantSchema = z.strictObject({
  participant_id: participantIdSchema,
  cli: slugSchema,
  model: nonemptyStringSchema,
  reasoning_effort: nonemptyStringSchema.optional(),
  stance: nonemptyStringSchema.optional(),
});

export const decisionOptionSchema = z.strictObject({
  id: slugSchema,
  label: nonemptyStringSchema,
});

export const errorEnvelopeSchema = z.strictObject({
  status: z.literal("failed"),
  error_type: nonemptyStringSchema,
  message: nonemptyStringSchema,
  job_id: uuidSchema.optional(),
});

export type Participant = z.infer<typeof participantSchema>;
export type DecisionOption = z.infer<typeof decisionOptionSchema>;
export type ExecutionIsolation = z.infer<typeof executionIsolationSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
