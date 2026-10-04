import { useEffect, useState } from "react";
import { Alert, Button, CircularProgress, Tooltip } from "@mui/material";
import { RefreshCw } from "lucide-react";
import { api } from "./api.js";
import type { BillingSummary, Money } from "../shared/billing.js";

const amount = (value: Money | null) =>
  value
    ? `${value.value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} ${value.currency}`
    : "未提供";
export default function BillingCard({ accountId }: { accountId: string }) {
  const [summary, setSummary] = useState<BillingSummary | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    setBusy(true);
    setError("");
    try {
      setSummary(await api<BillingSummary>(`/accounts/${accountId}/billing`));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, [accountId]);
  return (
    <section className="billing-card" aria-label="订阅额度">
      <div className="billing-heading">
        <b>订阅额度 / 费用</b>
        <Tooltip title="读取最新缓存，正常结果缓存 15 分钟">
          <Button
            size="small"
            disabled={busy}
            onClick={load}
            aria-label="刷新订阅额度"
          >
            {busy ? <CircularProgress size={14} /> : <RefreshCw size={14} />}
          </Button>
        </Tooltip>
      </div>
      {error && <Alert severity="warning">{error}</Alert>}
      {!summary && !error && <p className="muted">正在读取 Azure 账单…</p>}
      {summary && (
        <>
          <dl className="billing-values">
            <div>
              <dt>额度总额</dt>
              <dd>{amount(summary.credit.total)}</dd>
            </div>
            <div>
              <dt>{summary.credit.estimated ? "预计剩余额度" : "剩余额度"}</dt>
              <dd>{amount(summary.credit.remaining)}</dd>
            </div>
            <div>
              <dt>本月费用</dt>
              <dd>
                {summary.spending.status === "available"
                  ? summary.spending.amounts.map(amount).join(" / ") ||
                    "暂无记录"
                  : "无法读取"}
              </dd>
            </div>
          </dl>
          <p className="billing-note">
            {summary.credit.scope === "billingProfile" && (
              <strong>账单配置文件共享额度 · </strong>
            )}
            {summary.credit.message}
          </p>
          <p className="billing-note">{summary.spending.message}</p>
          {summary.credit.expiresAt && (
            <p className="billing-note">
              额度到期：
              {new Date(summary.credit.expiresAt).toLocaleDateString("zh-CN")}
            </p>
          )}
          <span className="billing-time">
            更新于 {new Date(summary.checkedAt).toLocaleString("zh-CN")}
          </span>
        </>
      )}
    </section>
  );
}
