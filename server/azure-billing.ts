import { Azure, AzureError, armUrl } from "./azure.js";
import { AppError } from "./store.js";
import type { Account, Credentials, Json } from "../shared/types.js";
import type { BillingSummary, Money } from "../shared/billing.js";

function money(input: Json | undefined): Money | null {
  return input &&
    typeof input.value === "number" &&
    Number.isFinite(input.value) &&
    typeof input.currency === "string" &&
    input.currency
    ? { value: input.value, currency: input.currency }
    : null;
}
function unavailable(error: unknown): {
  status: "unsupported" | "forbidden" | "error";
  message: string;
} {
  if (error instanceof AzureError && [401, 403].includes(error.azureStatus))
    return {
      status: "forbidden",
      message:
        "当前服务主体没有账单读取权限，需要相应 Billing / Cost Management 读取权限。",
    };
  if (error instanceof AzureError && [400, 404].includes(error.azureStatus))
    return {
      status: "unsupported",
      message: "此订阅或计费协议不支持该账单接口，请在 Azure Portal 查看。",
    };
  return {
    status: "error",
    message:
      error instanceof AppError
        ? error.message
        : "账单暂时无法读取，请稍后重试。",
  };
}
export class AzureBilling {
  constructor(private azure: Azure) {}
  async summary(
    credentials: Credentials,
    account: Account,
  ): Promise<BillingSummary> {
    const result: BillingSummary = {
      checkedAt: Date.now(),
      agreement: null,
      credit: {
        status: "unsupported",
        scope: null,
        total: null,
        remaining: null,
        estimated: false,
        expiresAt: null,
        message:
          "Azure 未提供可读取的赠送额度或余额；不是余额为 0。学生 / 赞助订阅请同时检查 Azure Portal。",
      },
      spending: {
        status: "unsupported",
        period: "MonthToDate",
        amounts: [],
        message: "尚未返回费用数据",
      },
    };
    const prefix = `/subscriptions/${account.subscriptionId}`;
    try {
      const { data } = await this.azure.request(
        credentials,
        "GET",
        `${prefix}/providers/Microsoft.Billing/billingProperty/default?api-version=2024-04-01`,
      );
      const properties = data.properties ?? {};
      result.agreement = properties.billingAccountAgreementType ?? null;
      const limits = (
        properties.billingProfileSpendingLimitDetails ?? []
      ).filter(
        (item: Json) =>
          ["Active", "LimitReached"].includes(item.status) &&
          (!item.endDate || Date.parse(item.endDate) > Date.now()),
      );
      // A billing profile can cover several subscriptions. Never label it as a subscription-only balance.
      if (limits.length === 1) {
        result.credit.total = money({
          value: limits[0].amount,
          currency: limits[0].currency,
        });
        result.credit.expiresAt = limits[0].endDate ?? null;
        result.credit.scope = "billingProfile";
      }
      const profile = properties.billingProfileId;
      if (
        typeof profile === "string" &&
        /^\/providers\/Microsoft\.Billing\/billingAccounts\/[^/?#]+\/billingProfiles\/[^/?#]+$/i.test(
          profile,
        )
      ) {
        const balance = await this.azure.request(
          credentials,
          "GET",
          `${armUrl(profile).href}/providers/Microsoft.Consumption/credits/balanceSummary?api-version=2024-08-01`,
        );
        const credit = balance.data.properties;
        if (credit) {
          result.credit.estimated = credit.isEstimatedBalance === true;
          result.credit.remaining = money(
            result.credit.estimated
              ? credit.balanceSummary?.estimatedBalance
              : credit.balanceSummary?.currentBalance,
          );
          if (result.credit.remaining) {
            result.credit.status = "available";
            result.credit.scope = "billingProfile";
            result.credit.message =
              "账单配置文件共享额度，可能由多个订阅共用；不能作为本订阅独立余额。";
          }
        }
      }
    } catch (error) {
      Object.assign(result.credit, unavailable(error));
    }
    try {
      const query = {
        type: "ActualCost",
        timeframe: "MonthToDate",
        dataset: {
          granularity: "None",
          aggregation: { totalCost: { name: "PreTaxCost", function: "Sum" } },
        },
      };
      let next: string | null =
        `${prefix}/providers/Microsoft.CostManagement/query?api-version=2025-03-01`;
      const seen = new Set<string>();
      const totals = new Map<string, number>();
      while (next) {
        const url = armUrl(next).href;
        if (seen.has(url) || seen.size >= 100)
          throw new AppError(502, "费用查询分页异常，未显示不完整金额");
        if (
          armUrl(url).pathname.toLowerCase() !==
          `${prefix}/providers/microsoft.costmanagement/query`.toLowerCase()
        )
          throw new AppError(502, "费用分页范围异常");
        seen.add(url);
        // CostManagement query uses POST but is read-only; no automatic retry.
        const response = await this.azure.request(
          credentials,
          "POST",
          url,
          query,
        );
        if (response.status === 204) break;
        const page = response.data.properties;
        if (!page || !Array.isArray(page.columns) || !Array.isArray(page.rows))
          throw new AppError(502, "费用响应格式无效，未将缺失数据显示为 0");
        const costIndex = page.columns.findIndex((column: Json) =>
          ["pretaxcost", "cost", "totalcost"].includes(
            String(column.name).toLowerCase(),
          ),
        );
        const currencyIndex = page.columns.findIndex(
          (column: Json) => String(column.name).toLowerCase() === "currency",
        );
        if (costIndex < 0 || currencyIndex < 0)
          throw new AppError(502, "费用响应缺少金额或币种字段");
        for (const row of page.rows) {
          if (
            typeof row[costIndex] !== "number" ||
            !Number.isFinite(row[costIndex]) ||
            typeof row[currencyIndex] !== "string" ||
            !row[currencyIndex]
          )
            throw new AppError(502, "费用金额或币种无效");
          totals.set(
            row[currencyIndex],
            (totals.get(row[currencyIndex]) ?? 0) + row[costIndex],
          );
        }
        next = page.nextLink ?? null;
      }
      result.spending = {
        status: "available",
        period: "MonthToDate",
        amounts: [...totals].map(([currency, value]) => ({ currency, value })),
        message: totals.size
          ? "本订阅本月至今实际费用（税前），账单数据可能延迟；并非累计已扣额度。"
          : "本月暂无费用记录。",
      };
    } catch (error) {
      result.spending = { ...result.spending, ...unavailable(error) };
    }
    return result;
  }
}
