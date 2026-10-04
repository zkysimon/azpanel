export interface Money {
  value: number;
  currency: string;
}
export interface BillingSummary {
  checkedAt: number;
  agreement: string | null;
  credit: {
    status: "available" | "unsupported" | "forbidden" | "error";
    scope: "billingProfile" | null;
    total: Money | null;
    remaining: Money | null;
    estimated: boolean;
    expiresAt: string | null;
    message: string;
  };
  spending: {
    status: "available" | "unsupported" | "forbidden" | "error";
    period: "MonthToDate";
    amounts: Money[];
    message: string;
  };
}
