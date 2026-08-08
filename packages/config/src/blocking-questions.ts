import { z } from "zod";

import source from "../../../contracts/blocking-questions.v1.json";

const identifier = z.string().regex(/^[a-z][a-z0-9_.-]{1,79}$/u);
const optionIdentifier = z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,119}$/u);
const overlayMutationSchema = z.object({
  path: z.array(z.string().min(1)).min(1).max(2),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
}).strict();
const optionSchema = z.object({
  id: optionIdentifier,
  label: z.string().trim().min(1),
  overlayMutations: z.array(overlayMutationSchema).min(1),
}).strict();
const questionSchema = z.object({
  id: identifier,
  label: z.string().trim().min(1),
  question: z.string().trim().min(1),
  // Authorization-only connectors are deliberately absent: a prerequisite is a
  // claim that the connector can supply data, which square cannot satisfy.
  connectorPrerequisites: z.array(
    z.enum(["lightspeed-r", "xero", "deputy"]),
  ).min(1),
  options: z.array(optionSchema).min(2),
}).strict();
const contractSchema = z.object({
  schemaVersion: z.literal(1),
  contractVersion: z.string().regex(/^albert-blocking-questions\/[1-9][0-9]*$/u),
  questions: z.array(questionSchema).min(1),
}).strict().superRefine((contract, context) => {
  const questionIds = new Set<string>();
  for (const [questionIndex, question] of contract.questions.entries()) {
    if (questionIds.has(question.id)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate blocking-question id: ${question.id}`,
        path: ["questions", questionIndex, "id"],
      });
    }
    questionIds.add(question.id);

    const optionIds = new Set<string>();
    for (const [optionIndex, option] of question.options.entries()) {
      if (optionIds.has(option.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate option id for ${question.id}: ${option.id}`,
          path: ["questions", questionIndex, "options", optionIndex, "id"],
        });
      }
      optionIds.add(option.id);

      const mutationPaths = new Set<string>();
      for (const [mutationIndex, mutation] of option.overlayMutations.entries()) {
        const path = mutation.path.join("\u0000");
        if (mutationPaths.has(path)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate overlay mutation path for ${question.id}/${option.id}`,
            path: [
              "questions",
              questionIndex,
              "options",
              optionIndex,
              "overlayMutations",
              mutationIndex,
              "path",
            ],
          });
        }
        mutationPaths.add(path);
      }
    }
  }
});
const envelopeSchema = z.object({
  digestAlgorithm: z.literal("sha256"),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  contract: contractSchema,
}).strict();

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

const parsed = envelopeSchema.parse(source);

/** Candidate contract. Its digest is not an approval; production must supply it explicitly. */
export const ALBERT_BLOCKING_QUESTIONS_CONTRACT = deepFreeze(parsed.contract);
export const ALBERT_BLOCKING_QUESTIONS_CONTRACT_VERSION = parsed.contract.contractVersion;
export const ALBERT_BLOCKING_QUESTIONS_CONTRACT_DIGEST = parsed.digest;
