import { z } from "zod";

export const aiServiceSchema = z.object({
  group: z.string().regex(/^[\w.()-]{1,90}$/),
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,63}$/),
});
export const aiCreateServiceSchema = aiServiceSchema
  .extend({
    name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}[a-zA-Z0-9]$/),
    location: z.string().regex(/^[a-z0-9]{2,40}$/),
    kind: z.enum(["OpenAI", "AIServices"]),
    confirmation: z.string(),
  })
  .refine((input) => input.name === input.confirmation, "确认名称不匹配");
export const aiDeploySchema = aiServiceSchema
  .extend({
    deployment: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/),
    model: z.object({
      format: z.string().min(1).max(100),
      name: z.string().min(1).max(150),
      version: z.string().min(1).max(100),
    }),
    sku: z.string().min(1).max(100),
    capacity: z.number().int().positive().max(1000000),
    confirmation: z.string(),
  })
  .refine(
    (input) => input.deployment === input.confirmation,
    "确认部署名称不匹配",
  );
export const aiDeleteSchema = aiServiceSchema
  .extend({
    deployment: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/),
    confirmation: z.string(),
  })
  .refine(
    (input) => input.deployment === input.confirmation,
    "确认部署名称不匹配",
  );
export type AiServiceRef = z.infer<typeof aiServiceSchema>;
export type AiCreateService = z.infer<typeof aiCreateServiceSchema>;
export type AiDeploy = z.infer<typeof aiDeploySchema>;
export interface AiService extends AiServiceRef {
  id: string;
  kind: string;
  location: string;
  state: string;
  endpoint: string | null;
}
export interface AiModelSku {
  name: string;
  usageName: string | null;
  minimum: number;
  maximum: number | null;
  step: number;
  default: number;
  allowedValues: number[];
}
export interface AiModel {
  format: string;
  name: string;
  version: string;
  lifecycle: string;
  publisher: string;
  capabilities: Record<string, string>;
  skus: AiModelSku[];
}
export interface AiDeployment {
  name: string;
  model: { format: string; name: string; version: string };
  sku: string;
  capacity: number;
  state: string;
}
export interface AiUsage {
  name: string;
  label: string;
  current: number;
  limit: number;
  unit: string;
}
