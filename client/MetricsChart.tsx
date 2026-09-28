import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { MetricPoint } from "../shared/types.js";

export default function MetricsChart({ metrics }: { metrics: MetricPoint[] }) {
  const data = metrics.map((point) => ({
    ...point,
    time: new Date(point.time).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    }),
  }));
  return (
    <div style={{ height: 250 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
          <XAxis dataKey="time" fontSize={11} />
          <YAxis domain={[0, 100]} unit="%" fontSize={11} />
          <Tooltip />
          <Area
            dataKey="cpu"
            name="CPU %"
            type="monotone"
            stroke="#7890db"
            fill="#7890db44"
            connectNulls={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
