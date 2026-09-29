import { z } from "zod";
import { imageRefSchema, looksLikeWindows } from "./images.js";

export const credentialsSchema = z.object({
  appId: z.string().uuid(),
  tenant: z.string().uuid(),
  password: z.string().min(1).max(512),
});
export const accountSchema = z.object({
  label: z.string().trim().min(1).max(100),
  credentials: credentialsSchema,
  subscriptionId: z.string().uuid().optional(),
});
export const regionSchema = z.string().regex(/^[a-z0-9]{2,40}$/);
export const sizeSchema = z.string().regex(/^Standard_[a-zA-Z0-9_]{1,80}$/);
export const vmNameSchema = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9-]{0,62}[a-zA-Z0-9]$|^[a-zA-Z]$/);
export const usernameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,30}$/)
  .refine(
    (value) =>
      ![
        "root",
        "admin",
        "administrator",
        "ubuntu",
        "debian",
        "test",
        "user",
      ].includes(value),
    "请使用自定义管理员用户名",
  );
export const cidrSchema = z.string().refine((value) => {
  const parts = value.split("/");
  return (
    parts.length === 2 &&
    parts[0].split(".").length === 4 &&
    parts[0].split(".").every((v) => /^\d{1,3}$/.test(v) && +v <= 255) &&
    /^\d{1,2}$/.test(parts[1]) &&
    +parts[1] <= 32
  );
}, "请输入有效 IPv4 CIDR，例如 203.0.113.10/32");

/** Reusable creation settings, shared by the wizard and saved presets. */
export const vmSettingsSchema = z
  .object({
    location: regionSchema,
    size: sizeSchema,
    image: imageRefSchema,
    diskSize: z.number().int().min(30).max(4095),
    username: usernameSchema,
    authentication: z.enum(["ssh", "password"]),
    sshKey: z.string().max(16384).default(""),
    password: z.string().max(123).default(""),
    allowedSource: cidrSchema,
    ipv6: z.boolean().default(false),
    customData: z.string().max(45000).default(""),
  })
  .superRefine((value, ctx) => {
    const error = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (
      value.authentication === "ssh" &&
      !/^ssh-rsa [A-Za-z0-9+/=]+(?: .*)?$/.test(value.sshKey.trim())
    )
      error("sshKey", "请输入 RSA SSH 公钥（ssh-rsa）");
    if (
      value.authentication === "password" &&
      (value.password.length < 12 ||
        [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) =>
          re.test(value.password),
        ).length < 3)
    )
      error("password", "密码至少 12 位，包含大小写、数字、符号中的三类");
    if (looksLikeWindows(value.image) && value.customData)
      error("customData", "启动脚本仅支持 Linux");
  });
export type VmSettings = z.infer<typeof vmSettingsSchema>;

export const createVmSchema = vmSettingsSchema
  .safeExtend({
    name: vmNameSchema,
    confirmation: z.string(),
  })
  .superRefine((value, ctx) => {
    const error = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (value.confirmation !== value.name)
      error("confirmation", "确认名称必须与虚拟机名称一致");
    if (looksLikeWindows(value.image)) {
      if (value.authentication !== "password")
        error("authentication", "Windows 需要密码认证");
      if (value.name.length > 15) error("name", "Windows 主机名称最多 15 位");
    }
  });
export type CreateVm = z.infer<typeof createVmSchema>;

export const presetSchema = z.object({
  name: z.string().trim().min(1).max(60),
  settings: vmSettingsSchema,
  isDefault: z.boolean().default(false),
});
export type VmPresetInput = z.infer<typeof presetSchema>;

export const inviteSchema = z.object({
  note: z.string().trim().max(80).default(""),
  maxUses: z.number().int().min(0).max(100000).default(0),
  expiresInDays: z.number().int().min(1).max(3650).nullable().default(null),
});
export type InviteInput = z.infer<typeof inviteSchema>;

export const passwordSchema = z.string().min(12).max(256);
export const registerSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: passwordSchema,
  inviteCode: z.string().trim().min(4).max(64),
});
